import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { encryptSecret } from '@/lib/crypto'
import {
  connectionSchemaFor, dataSourceConfigSchema, DATA_SOURCE_KIND_INFO, isDataSourceKind,
  publicDataSource, DATA_SOURCE_KINDS,
} from '@/lib/datasources/registry'

/** GET /api/datasources — configured external data sources (secrets never returned). */
export const GET = withAuth(async (_req, ctx) => {
  const rows = await db.dataSource.findMany({ where: { orgId: ctx.org.id }, orderBy: { createdAt: 'asc' } })
  return json({
    sources: rows.map(publicDataSource),
    kinds: DATA_SOURCE_KINDS.map((k) => DATA_SOURCE_KIND_INFO[k]),
  })
})

const createSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  kind: z.string().min(1),
  connection: z.record(z.string(), z.unknown()),
  config: dataSourceConfigSchema.optional(),
  enabled: z.boolean().optional(),
  autoSync: z.boolean().optional(),
  syncIntervalMin: z.coerce.number().int().min(5).max(10_080).optional(),
})

/** POST /api/datasources (owner/admin) — create a BYO data source for RAG. */
export const POST = withAuth(
  async (req, ctx) => {
    const body = await parseBody(req, createSchema)
    if (!isDataSourceKind(body.kind)) {
      throw new ApiError(422, `kind must be one of: ${DATA_SOURCE_KINDS.join(', ')}`, 'bad_kind')
    }

    const connectionParsed = connectionSchemaFor[body.kind].safeParse(body.connection)
    if (!connectionParsed.success) {
      const first = connectionParsed.error.issues[0]
      throw new ApiError(422, `Invalid connection.${first.path.join('.') || ''}: ${first.message}`, 'validation')
    }

    const configParsed = dataSourceConfigSchema.safeParse(body.config ?? {})
    if (!configParsed.success) {
      const first = configParsed.error.issues[0]
      throw new ApiError(422, `Invalid config.${first.path.join('.') || ''}: ${first.message}`, 'validation')
    }

    const source = await db.dataSource.create({
      data: {
        orgId: ctx.org.id,
        name: body.name,
        kind: body.kind,
        connectionEnc: encryptSecret(JSON.stringify(connectionParsed.data)),
        configJson: JSON.stringify(configParsed.data),
        enabled: body.enabled ?? false,
        autoSync: body.autoSync ?? false,
        syncIntervalMin: body.syncIntervalMin ?? 360,
      },
    })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'datasource.created',
      entity: 'data_source',
      entityId: source.id,
      meta: { name: source.name, kind: source.kind },
    })

    return json({ source: publicDataSource(source) }, 201)
  },
  { roles: ['owner', 'admin'] }
)
