import crypto from "node:crypto"
import { Socket } from "node:net"
import { Readable } from "node:stream"
import type { ServerOptions as McpServerOptions } from "@modelcontextprotocol/sdk/server/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js"
import { type IncomingHttpHeaders, IncomingMessage, ServerResponse } from "http"
import getRawBody from "raw-body"
import { createClient } from "redis"
import type z from "zod"
import { MAX_DURATION, MCP_URL } from "./constants"
import { getApiUrl, getRedisUrl } from "./utils"

interface ServerOptions extends McpServerOptions {
  parameters?: {
    schema: z.ZodSchema
  }
}

interface SerializedRequest {
  requestId: string
  url: string
  method: string
  body: string
  headers: IncomingHttpHeaders
}

const redisUrl = getRedisUrl()

export function initializeMcpApiHandler(
  initializeServer: (server: McpServer, apiKey: string, baseUrl?: string) => void,
  serverOptions: ServerOptions = {}
) {
  const redis = createClient({
    url: redisUrl
  })
  const redisPublisher = createClient({
    url: redisUrl
  })
  redis.on("error", (err) => {
    console.error("Redis error", err)
  })
  redisPublisher.on("error", (err) => {
    console.error("Redis error", err)
  })
  const redisPromise = Promise.all([redis.connect(), redisPublisher.connect()])

  let servers: McpServer[] = []

  let statelessServer: McpServer
  let statelessTransport: SSEServerTransport | null = null

  return async function mcpApiHandler(req: IncomingMessage, res: ServerResponse) {
    await redisPromise
    const url = new URL(req.url || "", MCP_URL)

    // Only validate API key for SSE and chat endpoints
    let apiKey: string | null = null
    let baseUrl: string | undefined

    if (url.pathname === "/sse" || url.pathname === "/message") {
      // If the environment is pre-prod, use the pre-prod API URL
      const environment = req.headers["x-environment"] || ""
      baseUrl = getApiUrl(Array.isArray(environment) ? environment[0] : environment)
      console.log("The environment is", environment)
      console.log("The API Base Url has been set to", baseUrl)

      // Try schema-based validation first if available
      if (
        serverOptions.parameters?.schema &&
        req.method === "POST" &&
        req.headers["content-length"]
      ) {
        try {
          const body = await getRawBody(req, {
            length: req.headers["content-length"],
            encoding: "utf-8"
          })

          const params = JSON.parse(body)
          const result = serverOptions.parameters.schema.safeParse(params)
          if (result.success) {
            apiKey = result.data.apiKey
          }
        } catch (error) {
          console.error("Error parsing parameters:", error)
        }
      }

      // If schema validation failed or not available, try headers
      if (!apiKey) {
        apiKey =
          (req.headers["x-meeting-baas-api-key"] as string) ||
          (req.headers["x-meetingbaas-apikey"] as string) ||
          (req.headers["x-api-key"] as string) ||
          (req.headers["authorization"] as string)?.replace(/bearer\s+/i, "") ||
          (process.env.NODE_ENV === "development" ? process.env.BAAS_API_KEY : null) ||
          null
      }

      // Authentication is optional, so we don't return an error if no API key is found
    }

    if (url.pathname === "/mcp") {
      if (req.method === "GET") {
        console.log("Received GET MCP request")
        res.writeHead(405).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed."
            },
            id: null
          })
        )
        return
      }
      if (req.method === "DELETE") {
        console.log("Received DELETE MCP request")
        res.writeHead(405).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32000,
              message: "Method not allowed."
            },
            id: null
          })
        )
        return
      }
      console.log("Got new MCP connection", req.url, req.method)

      if (!statelessServer) {
        statelessServer = new McpServer(
          {
            name: "mcp-typescript server on vercel",
            version: "0.1.0"
          },
          serverOptions
        )

        try {
          initializeServer(statelessServer, apiKey || "", baseUrl)
        } catch (error) {
          console.error("Error initializing server:", error)
          // Continue without failing - authentication is optional
        }
      }

      if (!statelessTransport) {
        statelessTransport = new SSEServerTransport("/message", res)
        await statelessServer.connect(statelessTransport)
      }

      await statelessTransport.handlePostMessage(req, res)
    } else if (url.pathname === "/sse") {
      console.log("Got new SSE connection")

      const transport = new SSEServerTransport("/message", res)
      const sessionId = transport.sessionId
      const server = new McpServer(
        {
          name: "mcp-typescript server on vercel",
          version: "0.1.0"
        },
        serverOptions
      )

      try {
        initializeServer(server, apiKey || "", baseUrl)
      } catch (error) {
        console.error("Error initializing server:", error)
        // Continue without failing - authentication is optional
      }

      servers.push(server)

      server.server.onclose = () => {
        console.log("SSE connection closed")
        servers = servers.filter((s) => s !== server)
      }

      let logs: {
        type: "log" | "error"
        messages: string[]
      }[] = []
      // This ensures that we logs in the context of the right invocation since the subscriber
      // is not itself invoked in request context.
      function logInContext(severity: "log" | "error", ...messages: string[]) {
        logs.push({
          type: severity,
          messages
        })
      }

      // Handles messages originally received via /message
      const handleMessage = async (message: string) => {
        console.log("Received message from Redis", message)
        logInContext("log", "Received message from Redis", message)
        const request = JSON.parse(message) as SerializedRequest

        // Make in IncomingMessage object because that is what the SDK expects.
        const req = createFakeIncomingMessage({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: request.body
        })
        const syntheticRes = new ServerResponse(req)
        let status = 100
        let body = ""
        syntheticRes.writeHead = (statusCode: number) => {
          status = statusCode
          return syntheticRes
        }
        syntheticRes.end = (b: unknown) => {
          body = b as string
          return syntheticRes
        }
        await transport.handlePostMessage(req, syntheticRes)

        await redisPublisher.publish(
          `responses:${sessionId}:${request.requestId}`,
          JSON.stringify({
            status,
            body
          })
        )

        if (status >= 200 && status < 300) {
          logInContext("log", `Request ${sessionId}:${request.requestId} succeeded: ${body}`)
        } else {
          logInContext(
            "error",
            `Message for ${sessionId}:${request.requestId} failed with status ${status}: ${body}`
          )
        }
      }

      const interval = setInterval(() => {
        for (const log of logs) {
          console[log.type].call(console, ...log.messages)
        }
        logs = []
      }, 100)

      await redis.subscribe(`requests:${sessionId}`, handleMessage)
      console.log(`Subscribed to requests:${sessionId}`)

      let timeout: NodeJS.Timeout
      let resolveTimeout: (value: unknown) => void
      const waitPromise = new Promise((resolve) => {
        resolveTimeout = resolve
        timeout = setTimeout(
          () => {
            resolve("max duration reached")
          },
          (MAX_DURATION - 5) * 1000
        )
      })

      async function cleanup() {
        clearTimeout(timeout)
        clearInterval(interval)
        await redis.unsubscribe(`requests:${sessionId}`, handleMessage)
        console.log("Done")
        res.statusCode = 200
        res.end()
      }
      req.on("close", () => resolveTimeout("client hang up"))

      await server.connect(transport)
      const closeReason = await waitPromise
      console.log(closeReason)
      await cleanup()
    } else if (url.pathname === "/message") {
      console.log("Received message")

      const body = await getRawBody(req, {
        length: req.headers["content-length"],
        encoding: "utf-8"
      })

      const sessionId = url.searchParams.get("sessionId") || ""
      if (!sessionId) {
        res.statusCode = 400
        res.end("No sessionId provided")
        return
      }
      const requestId = crypto.randomUUID()
      const serializedRequest: SerializedRequest = {
        requestId,
        url: req.url || "",
        method: req.method || "",
        body: body,
        headers: req.headers
      }

      // Handles responses from the /sse endpoint.
      await redis.subscribe(`responses:${sessionId}:${requestId}`, (message) => {
        clearTimeout(timeout)
        const response = JSON.parse(message) as {
          status: number
          body: string
        }
        res.statusCode = response.status
        res.end(response.body)
      })

      // Queue the request in Redis so that a subscriber can pick it up.
      // One queue per session.
      await redisPublisher.publish(`requests:${sessionId}`, JSON.stringify(serializedRequest))
      console.log(`Published requests:${sessionId}`, serializedRequest)

      const timeout = setTimeout(async () => {
        await redis.unsubscribe(`responses:${sessionId}:${requestId}`)
        res.statusCode = 408
        res.end("Request timed out")
      }, 10 * 1000)

      res.on("close", async () => {
        clearTimeout(timeout)
        await redis.unsubscribe(`responses:${sessionId}:${requestId}`)
      })
    } else {
      res.statusCode = 404
      res.end("Not found")
    }
  }
}

// Define the options interface
interface FakeIncomingMessageOptions {
  method?: string
  url?: string
  headers?: IncomingHttpHeaders
  body?: string | Buffer | Record<string, unknown> | null
  socket?: Socket
}

// Create a fake IncomingMessage
function createFakeIncomingMessage(options: FakeIncomingMessageOptions = {}): IncomingMessage {
  const { method = "GET", url = "/", headers = {}, body = null, socket = new Socket() } = options

  // Create a readable stream that will be used as the base for IncomingMessage
  const readable = new Readable()
  readable._read = (): void => {} // Required implementation

  // Add the body content if provided
  if (body) {
    if (typeof body === "string") {
      readable.push(body)
    } else if (Buffer.isBuffer(body)) {
      readable.push(body)
    } else {
      readable.push(JSON.stringify(body))
    }
    readable.push(null) // Signal the end of the stream
  }

  // Create the IncomingMessage instance
  const req = new IncomingMessage(socket)

  // Set the properties
  req.method = method
  req.url = url
  req.headers = headers

  // Copy over the stream methods
  req.push = readable.push.bind(readable)
  req.read = readable.read.bind(readable)
  req.on = readable.on.bind(readable) as IncomingMessage["on"]
  req.pipe = readable.pipe.bind(readable)

  return req
}
