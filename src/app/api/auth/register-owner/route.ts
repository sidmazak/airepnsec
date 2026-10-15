import { z } from 'zod'
import { withPublic, json, fail, parseBody, createSession, sessionCookie } from '@/lib/api'
import { db } from '@/lib/db'
import { hashPassword } from '@/lib/crypto'
import { audit } from '@/lib/audit'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const schema = z.object({
  orgName: z.string().trim().min(2, 'Organization name must be at least 2 characters').max(80),
  businessType: z.enum(['apartment_rental', 'car_rental', 'salon', 'clinic', 'contractor', 'generic']).default('generic'),
  name: z.string().trim().min(1, 'Your name is required').max(80),
  email: z.string().trim().regex(EMAIL_RE, 'Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
})

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'my-business'
}

async function uniqueSlug(base: string): Promise<string> {
  let candidate = base
  let n = 1
  // Slug is globally unique in the schema; append -2, -3, ... until free.
  while (await db.organization.findUnique({ where: { slug: candidate }, select: { id: true } })) {
    n += 1
    candidate = `${base}-${n}`
  }
  return candidate
}

const DEFAULT_BUSINESS_DAYS = [1, 2, 3, 4, 5] // Mon–Fri
const START_MIN = 9 * 60 // 09:00
const END_MIN = 17 * 60 // 17:00

/**
 * POST /api/auth/register-owner — one-time bootstrap.
 * Only works while zero users exist. Creates the organization (unique slug),
 * the owner account, default Mon–Fri 9–17 working hours, sane booking policy,
 * and default provider rows (no LLM — the operator configures one; local neural embeddings).
 * Returns the session cookie so the new owner lands straight in the app.
 */
export const POST = withPublic(async (req) => {
  const body = await parseBody(req, schema)

  if ((await db.user.count()) > 0) {
    return fail(403, 'An owner already exists. Sign in instead.', { code: 'setup_locked' })
  }

  const email = body.email.trim().toLowerCase()
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) {
    return fail(409, 'An account with this email already exists', { code: 'email_taken' })
  }

  const slug = await uniqueSlug(slugify(body.orgName))

  const org = await db.organization.create({
    data: {
      name: body.orgName.trim(),
      slug,
      businessType: body.businessType,
      policies: JSON.stringify({ autoConfirmBookings: true } satisfies { autoConfirmBookings: boolean }),
      openingHours: JSON.stringify(
        Object.fromEntries(DEFAULT_BUSINESS_DAYS.map((dow) => [String(dow), [['09:00', '17:00']]]))
      ),
    },
  })

  const user = await db.user.create({
    data: {
      orgId: org.id,
      email,
      passwordHash: hashPassword(body.password),
      name: body.name,
      role: 'owner',
    },
  })

  await db.workingHour.createMany({
    data: DEFAULT_BUSINESS_DAYS.map((dow) => ({
      orgId: org.id,
      staffId: null,
      dow,
      startMin: START_MIN,
      endMin: END_MIN,
    })),
  })

  await db.providerConfig.createMany({
    data: [
      { orgId: org.id, capability: 'llm', provider: 'none', enabled: false },
      { orgId: org.id, capability: 'embedding', provider: 'local_neural', enabled: true },
    ],
  })

  await audit({
    orgId: org.id,
    actorType: 'user',
    actorId: user.id,
    action: 'setup.owner_registered',
    entity: 'organization',
    entityId: org.id,
    meta: { orgName: org.name, slug, businessType: org.businessType },
  })

  const { token, expiresAt } = await createSession(user.id)
  const res = json(
    {
      ok: true,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      org: { id: org.id, name: org.name, slug: org.slug },
    },
    201
  )
  res.headers.append('set-cookie', sessionCookie(token, expiresAt))
  return res
})
