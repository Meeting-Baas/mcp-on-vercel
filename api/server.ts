import type { BaasTypes } from "@meeting-baas/sdk";
import { BaasClient, MpcClient } from "@meeting-baas/sdk";
import { IncomingMessage } from "http";
import { createClient } from "redis";
import { z } from "zod";
import { initializeMcpApiHandler } from "../lib/mcp-api-handler";

// Initialize Redis client
const redis = createClient({
  url: process.env.REDIS_URL,
});

redis.on("error", (err) => console.error("Redis Client Error", err));

// Initialize MPC client for tool registration
const mpcClient = new MpcClient({
  serverUrl: process.env.MPC_SERVER_URL || "",
});

interface ToolParameter {
  name: string;
  required?: boolean;
  schema?: {
    type: string;
  };
}

// Helper function to convert MPC parameter definition to Zod schema
function convertToZodSchema(parameters: ToolParameter[]): z.ZodRawShape {
  const schema: z.ZodRawShape = {};
  for (const param of parameters) {
    if (param.required) {
      schema[param.name] = z.string();
    } else {
      schema[param.name] = z.string().optional();
    }
  }
  return schema;
}

// Helper to get BaaS client for each request
function getBaasClient(req: IncomingMessage): BaasClient {
  const url = new URL(req.url || "", "https://example.com");
  const apiKey = url.searchParams.get("X-Meeting-BaaS-Key") || "";
  return new BaasClient({
    apiKey,
  });
}

// Type guard to check if an object has required properties
function hasRequiredProperties<T extends object>(
  obj: unknown,
  required: (keyof T)[]
): obj is T {
  if (typeof obj !== "object" || obj === null) {
    return false;
  }
  return required.every((prop) => prop in obj);
}

const handler = initializeMcpApiHandler(
  (server) => {
    return async (req: IncomingMessage) => {
      // Connect to Redis
      await redis.connect();

      // Get BaaS client for this request
      const baasClient = getBaasClient(req);

      // Register all Meeting BaaS tools automatically
      const tools = mpcClient.getRegisteredTools();
      for (const tool of tools) {
        const paramsSchema = convertToZodSchema(tool.parameters || []);
        server.tool(
          tool.name,
          paramsSchema,
          async (params: Record<string, string>) => {
            // Transform string parameters to their proper types
            const transformedParams = Object.entries(params).reduce(
              (acc, [key, value]) => {
                // Handle boolean parameters
                if (value === "true" || value === "false") {
                  acc[key] = value === "true";
                }
                // Handle number parameters
                else if (!isNaN(Number(value))) {
                  acc[key] = Number(value);
                }
                // Handle object parameters (like speechToText)
                else if (value.startsWith("{")) {
                  try {
                    acc[key] = JSON.parse(value);
                  } catch (e) {
                    acc[key] = value;
                  }
                }
                // Keep string parameters as is
                else {
                  acc[key] = value;
                }
                return acc;
              },
              {} as Record<string, any>
            );

            // Use the corresponding BaaS client method
            const method = tool.name as keyof typeof baasClient;

            // Type check based on the method
            switch (method) {
              case "joinMeeting":
                if (
                  !hasRequiredProperties<BaasTypes.JoinRequest>(
                    transformedParams,
                    ["botName", "meetingUrl", "reserved"]
                  )
                ) {
                  throw new Error(
                    "Missing required parameters for joinMeeting"
                  );
                }
                break;
              case "createCalendar":
                if (
                  !hasRequiredProperties<BaasTypes.CreateCalendarParams>(
                    transformedParams,
                    [
                      "oauth_client_id",
                      "oauth_client_secret",
                      "oauth_refresh_token",
                      "platform",
                    ]
                  )
                ) {
                  throw new Error(
                    "Missing required parameters for createCalendar"
                  );
                }
                break;
              case "getMeetingData":
                if (
                  !hasRequiredProperties<BaasTypes.GetMeetingDataQuery>(
                    transformedParams,
                    ["bot_id"]
                  )
                ) {
                  throw new Error(
                    "Missing required parameters for getMeetingData"
                  );
                }
                break;
              case "deleteData":
                if (
                  !hasRequiredProperties<BaasTypes.BotIdParam>(
                    transformedParams,
                    ["bot_id"]
                  )
                ) {
                  throw new Error("Missing required parameters for deleteData");
                }
                break;
              case "listCalendars":
                // No required parameters
                break;
              case "getCalendar":
                if (
                  !hasRequiredProperties<BaasTypes.CalendarUuidParam>(
                    transformedParams,
                    ["calendar_uuid"]
                  )
                ) {
                  throw new Error(
                    "Missing required parameters for getCalendar"
                  );
                }
                break;
              case "deleteCalendar":
                if (
                  !hasRequiredProperties<BaasTypes.CalendarUuidParam>(
                    transformedParams,
                    ["calendar_uuid"]
                  )
                ) {
                  throw new Error(
                    "Missing required parameters for deleteCalendar"
                  );
                }
                break;
              case "resyncAllCalendars":
                // No required parameters
                break;
            }

            const result = await baasClient[method](transformedParams as any);
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            };
          }
        );
      }

      // Add a Redis test tool
      server.tool(
        "redis_test",
        { key: z.string(), value: z.string() },
        async ({ key, value }: { key: string; value: string }) => {
          await redis.set(key, value);
          const result = await redis.get(key);
          return {
            content: [
              {
                type: "text",
                text: `Redis test: stored ${key}=${value}, retrieved ${result}`,
              },
            ],
          };
        }
      );

      // Keep the existing echo tool as an example
      server.tool(
        "echo",
        { message: z.string() },
        async ({ message }: { message: string }) => ({
          content: [{ type: "text", text: `Tool echo: ${message}` }],
        })
      );
    };
  },
  {
    capabilities: {
      tools: {
        echo: {
          description: "Echo a message",
        },
        redis_test: {
          description:
            "Test Redis connection by storing and retrieving a key-value pair",
        },
      },
    },
  }
);

export default handler;
