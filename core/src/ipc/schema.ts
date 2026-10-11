import { z } from 'zod';

// JSON-RPC 2.0 Schemas
export const JsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.any().optional()
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.any().optional()
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  result: z.any().optional(),
  error: JsonRpcErrorSchema.optional()
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.any()
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

// Business Payloads & Schemas
export const LogLevelSchema = z.enum(['info', 'warn', 'error', 'request', 'system']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogEventSchema = z.object({
  id: z.number(),
  timestamp: z.string(),
  level: LogLevelSchema,
  message: z.string(),
  raw: z.string()
});
export type LogEvent = z.infer<typeof LogEventSchema>;

export const ServiceStateSchema = z.enum(['STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR']);
export type ServiceState = z.infer<typeof ServiceStateSchema>;

export const AccountInfoSchema = z.object({
  email: z.string().optional(),
  projectId: z.string().optional(),
  health: z.number().default(100),
  models: z.array(z.string()).default([]),
  cooldowns: z.record(z.string(), z.any()).optional()
});
export type AccountInfo = z.infer<typeof AccountInfoSchema>;

export const CoreStatusSchema = z.object({
  state: ServiceStateSchema,
  version: z.string(),
  pid: z.number().nullable(),
  host: z.string(),
  port: z.number(),
  uptime: z.number(),
  startTime: z.number().nullable(),
  activeAccountsCount: z.number(),
  accounts: z.array(AccountInfoSchema).default([]),
  supportedModels: z.array(z.string()).default([]),
  strategy: z.string().optional(),
  outboundProxy: z.string().nullable().optional()
});
export type CoreStatus = z.infer<typeof CoreStatusSchema>;

export const SubscribeParamsSchema = z.object({
  topics: z.array(z.enum(['logs', 'status', 'accounts', 'all']))
});
export type SubscribeParams = z.infer<typeof SubscribeParamsSchema>;
