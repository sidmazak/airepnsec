import { z } from 'zod'
import { withAuth, json, parseBody, ApiError } from '@/lib/api'
import { db } from '@/lib/db'
import { audit } from '@/lib/audit'
import { encryptSecret } from '@/lib/crypto'
import { connectionSchemaFor, dataSourceConfigSchema, isDataSourceKind, publicDataSource } from '@/lib/datasources/registry'

async function loadSource(orgId: string, id: string) {
  const source = await db.dataSource.findFirst({ where: { id, orgId } })
  if (!source) throw new ApiError(404, 'Data source not found', 'not_found')
  return source
}

/** GET /api/datasources/[id] */
export const GET = withAuth(async (_req, ctx, params) => {
  const source = await loadSource(ctx.org.id, params.id)
  return json({ source: publicDataSource(source) })
})

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  connection: z.record(z.string(), z.unknown()).nullable().optional(),
  config: dataSourceConfigSchema.optional(),
  enabled: z.boolean().optional(),
  autoSync: z.boolean().optional(),
  syncIntervalMin: z.coerce.number().int().min(5).max(10_080).optional(),
})

/** PATCH /api/datasources/[id] (owner/admin) — connection:null clears credentials (disables the source). */
export const PATCH = withAuth(
  async (req, ctx, params) => {
    const source = await loadSource(ctx.org.id, params.id)
    const body = await parseBody(req, patchSchema)
    const changed: string[] = []
    const data: Record<string, unknown> = {}

    if (body.name !== undefined) { data.name = body.name; changed.push('name') }

    if (body.connection !== undefined) {
      if (body.connection === null) {
        data.connectionEnc = ''
        data.enabled = false
        changed.push('connection')
      } else {
        if (!isDataSourceKind(source.kind)) throw new ApiError(422, `Unsupported kind: ${source.kind}`, 'bad_kind')
        const parsed = connectionSchemaFor[source.kind].safeParse(body.connection)
        if (!parsed.success) {
          const first = parsed.error.issues[0]
          throw new ApiError(422, `Invalid connection.${first.path.join('.') || ''}: ${first.message}`, 'validation')
        }
        data.connectionEnc = encryptSecret(JSON.stringify(parsed.data))
        changed.push('connection')
      }
    }

    if (body.config !== undefined) {
      const parsed = dataSourceConfigSchema.safeParse(body.config)
      if (!parsed.success) {
        const first = parsed.error.issues[0]
        throw new ApiError(422, `Invalid config.${first.path.join('.') || ''}: ${first.message}`, 'validation')
      }
      data.configJson = JSON.stringify(parsed.data)
      changed.push('config')
    }

    if (body.enabled !== undefined) {
      if (body.enabled) {
        const hasConnection = data.connectionEnc !== undefined ? data.connectionEnc !== '' : Boolean(source.connectionEnc)
        if (!hasConnection) throw new ApiError(400, 'Add a connection before enabling this data source', 'not_configured')
      }
      data.enabled = body.enabled
      changed.push('enabled')
    }

    if (body.autoSync !== undefined) { data.autoSync = body.autoSync; changed.push('autoSync') }
    if (body.syncIntervalMin !== undefined) { data.syncIntervalMin = body.syncIntervalMin; changed.push('syncIntervalMin') }

    const updated = await db.dataSource.update({ where: { id: source.id }, data })

    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'datasource.updated',
      entity: 'data_source',
      entityId: source.id,
      meta: { name: updated.name, changed },
    })

    return json({ source: publicDataSource(updated) })
  },
  { roles: ['owner', 'admin'] }
)

/** DELETE /api/datasources/[id] (owner/admin) — removes the source and its ingested documents. */
export const DELETE = withAuth(
  async (_req, ctx, params) => {
    const source = await loadSource(ctx.org.id, params.id)
    await db.dataSource.delete({ where: { id: source.id } })
    await audit({
      orgId: ctx.org.id,
      actorType: 'user',
      actorId: ctx.user.id,
      action: 'datasource.deleted',
      entity: 'data_source',
      entityId: source.id,
      meta: { name: source.name, kind: source.kind, documents: source.documentCount },
    })
    return json({ deleted: true })
  },
  { roles: ['owner', 'admin'] }
)
