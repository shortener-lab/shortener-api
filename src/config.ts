import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const csv = z
  .string()
  .min(1)
  .transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean));

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_VERSION: z.string().default('dev'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool,
  DATABASE_SSL_CA_FILE: z.string().optional(),
  REDIS_URL: z.string().min(1),
  KAFKA_BROKERS: csv,
  KAFKA_SSL: bool,
  KAFKA_REPLICATION_FACTOR: z.coerce.number().int().min(1).default(1),
});

const apiSchema = baseSchema.extend({
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().min(1),
  API_KEY: z.string().min(16),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(10),
  OIDC_ISSUER: z.url(),
  OIDC_AUDIENCE: z.string().min(1),
  OIDC_JWKS_URL: z.url(),
  CORS_ALLOWED_ORIGINS: csv,
});

const workerSchema = baseSchema.extend({
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3001),
});

export type BaseConfig = z.infer<typeof baseSchema>;
export type ApiConfig = z.infer<typeof apiSchema>;
export type WorkerConfig = z.infer<typeof workerSchema>;

function parse<S extends z.ZodType>(schema: S, env: Record<string, string | undefined>): z.infer<S> {
  const result = schema.safeParse(env);
  if (!result.success) {
    throw new Error(`Configuração inválida:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export const loadBaseConfig = (env: Record<string, string | undefined> = process.env) => parse(baseSchema, env);
export const loadApiConfig = (env: Record<string, string | undefined> = process.env) => parse(apiSchema, env);
export const loadWorkerConfig = (env: Record<string, string | undefined> = process.env) => parse(workerSchema, env);
