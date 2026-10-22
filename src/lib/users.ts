/**
 * Team / membership business rules shared by the user-management routes.
 *
 * Core invariants:
 *  - A user is addressed by email; no endpoint ever exposes the password hash
 *    or the TOTP secret.
 *  - Deactivation revokes live sessions; accounts are never hard-deleted
 *    (audit history is retained). The last active owner may NOT be demoted or
 *    deactivated.
 *  - Only an owner may manage another owner or promote somebody to owner.
 *    An admin may manage agents and viewers only.
 *  - Invites expire, can be revoked, and are consumed exactly once.
 *  - Password resets are one-time tokens, emailed through the outbox.
 */
import { db } from '@/lib/db'
import { ApiError, createSession } from '@/lib/api'
import { hashPassword, randomToken, sha256 } from '@/lib/crypto'
import { audit } from '@/lib/audit'

export type TeamRole = 'owner' | 'admin' | 'agent' | 'viewer'
export const TEAM_ROLES: readonly TeamRole[] = ['owner', 'admin', 'agent', 'viewer'] as const

export type TeamMember = {
  id: string
  email: string
  name: string
  role: TeamRole
  active: boolean
  twoFactorEnabled: boolean
  lastLoginAt: string | null
  createdAt: string
}

export type InviteState = {
  id: string
  email: string
  role: TeamRole
  createdAt: string
  expiresAt: string
  acceptedAt: string | null
  revokedAt: string | null
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function isValidRole(role: unknown): role is TeamRole {
  return TEAM_ROLES.includes(role as TeamRole)
}

/** Roles the given actor role is allowed to manage. */
export function manageableRoles(actorRole: string): TeamRole[] {
  if (actorRole === 'owner') return ['owner', 'admin', 'agent', 'viewer']
  if (actorRole === 'admin') return ['agent', 'viewer']
  return []
}

/** True when `actorRole` may change a member whose current role is `targetRole`. */
export function canManageRole(actorRole: string, targetRole: string): boolean {
  if (!isValidRole(targetRole)) return false
  return manageableRoles(actorRole).includes(targetRole as TeamRole)
}

async function activeOwnerCount(orgId: string): Promise<number> {
  return db.user.count({ where: { orgId, role: 'owner', active: true } })
}

function memberSelect() {
  return {
    id: true, email: true, name: true, role: true, active: true,
    twoFactorEnabled: true, lastLoginAt: true, createdAt: true,
  } as const
}

/* ---------------- listing ---------------- */

export async function listMembers(orgId: string): Promise<TeamMember[]> {
  const rows = await db.user.findMany({ where: { orgId }, select: memberSelect(), orderBy: { name: 'asc' } })
  return rows as unknown as TeamMember[]
}

/* ---------------- invitations ---------------- */

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function appBaseUrl(): string {
  return (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
}

/**
 * Create an invite, enqueue the invitation email, and return the single-use
 * invitation URL. The plain token is returned to the inviter ONCE so they can
 * hand the link over when email delivery is not configured (no SMTP).
 */
export async function createInvite(
  orgId: string,
  actorId: string,
  input: { email: string; name?: string; role?: TeamRole }
): Promise<{ invite: InviteState; inviteUrl: string }> {
  const email = input.email.trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new ApiError(422, 'An invite requires a valid email address', 'invalid_email')
  const role: TeamRole = isValidRole(input.role) ? input.role : 'agent'
  const token = randomToken(32)
  const tokenHash = sha256(token)
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
  const invite = await db.invite.create({
    data: { orgId, email, role, tokenHash, invitedById: actorId, expiresAt },
  })
  await audit({
    orgId, actorType: 'user', actorId: actorId,
    action: 'member.invited', entity: 'invite', entityId: invite.id,
    meta: { email, role },
  })
  const inviteUrl = `${appBaseUrl()}/#?join=${token}`
  await db.outboxMessage.create({
    data: {
      orgId, channel: 'email', recipient: email,
      subject: 'You were invited to join AI Secretary',
      body:
        `You have been invited to join this organisation as ${role}.\n\n` +
        `Open this link to set your password and join:\n${inviteUrl}\n\n` +
        `The link works once. If you were not expecting this invitation, ignore this message.`,
      dedupeKey: `invite:${invite.id}`,
    },
  })
  return {
    invite: {
      id: invite.id, email, role: role as TeamRole, createdAt: invite.createdAt.toISOString(),
      expiresAt: invite.expiresAt.toISOString(), acceptedAt: null, revokedAt: null,
    },
    inviteUrl,
  }
}

/** Resolve an invite by its plain token (read-only; used by the join screen). */
export async function resolveInviteToken(plainToken: string): Promise<InviteState | null> {
  if (!plainToken) return null
  const row = await db.invite.findUnique({ where: { tokenHash: sha256(plainToken) } })
  if (!row || row.revokedAt || row.acceptedAt || row.expiresAt < new Date()) return null
  return {
    id: row.id, email: row.email, role: row.role as TeamRole, createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(), acceptedAt: null, revokedAt: null,
  }
}

/**
 * Accept an invite: create the account, consume the invite, mint a session.
 * The consume step is a conditional UPDATE, so two concurrent accepts can never
 * create two accounts.
 */
export async function acceptInvite(
  plainToken: string,
  input: { name?: string; password: string }
): Promise<{ user: { id: string; email: string; name: string; role: TeamRole }; sessionToken: string; sessionExpiresAt: Date }> {
  if (input.password.length < 8 || input.password.length > 200) {
    throw new ApiError(422, 'A password must be 8 to 200 characters', 'bad_password')
  }
  const row = await db.invite.findUnique({ where: { tokenHash: sha256(plainToken) } })
  if (!row || row.revokedAt || row.acceptedAt || row.expiresAt < new Date()) {
    throw new ApiError(400, 'That invitation is invalid, expired, or already used', 'invite_invalid')
  }
  // One-shot consume (atomic conditional update).
  const consumed = await db.invite.updateMany({
    where: { id: row.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    data: { acceptedAt: new Date() },
  })
  if (consumed.count === 0) {
    throw new ApiError(400, 'That invitation is invalid, expired, or already used', 'invite_invalid')
  }
  const name = (input.name ?? '').trim() || row.email
  let user
  try {
    user = await db.user.create({
      data: { orgId: row.orgId, email: row.email, passwordHash: hashPassword(input.password), name, role: row.role },
    })
  } catch (err) {
    // The email is globally unique. If it already has an account, the invite
    // cannot be used to create a second one.
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      throw new ApiError(409, 'That email address already has an account', 'email_taken')
    }
    throw err
  }
  await audit({
    orgId: row.orgId, actorType: 'user', actorId: user.id,
    action: 'member.joined', entity: 'user', entityId: user.id,
    meta: { email: row.email, role: row.role },
  })
  const { token, expiresAt } = await createSession(user.id)
  return { user: { id: user.id, email: user.email, name: user.name, role: row.role as TeamRole }, sessionToken: token, sessionExpiresAt: expiresAt }
}

/** List pending invites. */
export async function listInvites(orgId: string): Promise<InviteState[]> {
  const rows = await db.invite.findMany({
    where: { orgId, acceptedAt: null, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  return rows.map((r) => ({
    id: r.id, email: r.email, role: r.role as TeamRole, createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(), acceptedAt: null, revokedAt: null,
  }))
}

/** Revoke a pending invite. */
export async function revokeInvite(orgId: string, inviteId: string, actorId: string): Promise<void> {
  const row = await db.invite.findUnique({ where: { id: inviteId } })
  if (!row || row.orgId !== orgId) throw new ApiError(404, 'Invite not found', 'not_found')
  if (row.acceptedAt || row.revokedAt) throw new ApiError(409, 'Invite is already used or revoked', 'invite_used')
  await db.invite.update({ where: { id: inviteId }, data: { revokedAt: new Date() } })
  await audit({
    orgId, actorType: 'user', actorId: actorId,
    action: 'member.invite_revoked', entity: 'invite', entityId: inviteId, meta: {},
  })
}

/* ---------------- membership edits ---------------- */

/**
 * Change a member's name / role / active flag. All guard rails live here so
 * every route behaves identically.
 */
export async function updateMember(
  orgId: string,
  actorId: string,
  actorRole: string,
  userId: string,
  input: { name?: string; role?: TeamRole; active?: boolean }
): Promise<TeamMember> {
  const target = await db.user.findFirst({ where: { id: userId, orgId } })
  if (!target) throw new ApiError(404, 'Member not found', 'not_found')
  if (target.id === actorId && input.active === false) {
    throw new ApiError(409, 'You cannot deactivate your own account', 'cannot_deactivate_self')
  }
  if (input.role !== undefined && !isValidRole(input.role)) {
    throw new ApiError(422, 'Invalid role', 'bad_role')
  }
  // The actor may only manage roles they are allowed to manage.
  if (input.role !== undefined && input.role !== target.role) {
    if (!canManageRole(actorRole, target.role) || !canManageRole(actorRole, input.role)) {
      throw new ApiError(403, 'You cannot change this member’s role', 'forbidden')
    }
  }
  if (input.active !== undefined && input.active !== target.active) {
    if (!canManageRole(actorRole, target.role)) {
      throw new ApiError(403, 'You cannot change this member’s status', 'forbidden')
    }
  }
  // Never leave the organisation without an active owner.
  const losesOwner = target.role === 'owner' && target.active && (input.role !== undefined && input.role !== 'owner' || input.active === false)
  if (losesOwner) {
    const owners = await activeOwnerCount(orgId)
    if (owners <= 1) throw new ApiError(409, 'This is the only active owner — promote somebody else first', 'last_owner')
  }
  const updated = await db.user.update({
    where: { id: userId },
    data: {
      name: input.name !== undefined ? input.name.trim() : undefined,
      role: input.role,
      active: input.active,
    },
    select: memberSelect(),
  })
  if (input.active === false) await db.session.updateMany({ where: { userId }, data: { revokedAt: new Date() } })
  await audit({
    orgId, actorType: 'user', actorId: actorId,
    action: 'member.updated', entity: 'user', entityId: userId,
    meta: { role: input.role ?? '', active: input.active ?? null },
  })
  return updated as unknown as TeamMember
}

/* ---------------- sessions ---------------- */

/** Revoke every session of a member (deactivated members are signed out). */
export async function revokeMemberSessions(orgId: string, userId: string, actorId: string): Promise<number> {
  const target = await db.user.findFirst({ where: { id: userId, orgId }, select: { id: true } })
  if (!target) throw new ApiError(404, 'Member not found', 'not_found')
  const res = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
  await audit({
    orgId, actorType: 'user', actorId: actorId,
    action: 'member.sessions_revoked', entity: 'user', entityId: userId, meta: { count: res.count },
  })
  return res.count
}

/* ---------------- password reset ---------------- */

const RESET_TTL_MS = 60 * 60 * 1000 // 1 hour

/**
 * Issue a one-time password reset token and email the link. Only an owner may
 * reset somebody else's password.
 */
export async function issueResetLink(
  orgId: string,
  userId: string,
  actorId: string,
  actorRole: string
): Promise<{ link: string }> {
  if (actorRole !== 'owner') throw new ApiError(403, 'Only an owner can reset another member’s password', 'forbidden')
  const user = await db.user.findFirst({ where: { id: userId, orgId }, select: { id: true, email: true } })
  if (!user) throw new ApiError(404, 'Member not found', 'not_found')
  const token = randomToken(32)
  await db.passwordResetToken.create({
    data: { userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TTL_MS) },
  })
  await audit({
    orgId, actorType: 'user', actorId: actorId,
    action: 'member.password_reset_issued', entity: 'user', entityId: userId, meta: {},
  })
  const link = `${appBaseUrl()}/#/reset-password?token=${token}`
  await db.outboxMessage.create({
    data: {
      orgId, channel: 'email', recipient: user.email,
      subject: 'Reset your AI Secretary password',
      body:
        `Use this link to set a new password, then sign in again:\n${link}\n\n` +
        `The link works once within one hour. If you did not request a reset, ignore this message.`,
      dedupeKey: `reset:${userId}:${token.slice(0, 8)}`,
    },
  })
  return { link }
}

/** Set a new password from a valid token; every session of that user is revoked. */
export async function resetPasswordWithToken(plainToken: string, password: string): Promise<{ email: string }> {
  if (password.length < 8 || password.length > 200) {
    throw new ApiError(422, 'A password must be 8 to 200 characters', 'bad_password')
  }
  const rec = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256(plainToken) },
    include: { user: { select: { id: true, orgId: true, email: true } } },
  })
  if (!rec || rec.usedAt || rec.expiresAt < new Date()) {
    throw new ApiError(400, 'This reset link is invalid, expired, or already used', 'reset_invalid')
  }
  const consumed = await db.passwordResetToken.updateMany({
    where: { id: rec.id, usedAt: null },
    data: { usedAt: new Date() },
  })
  if (consumed.count === 0) throw new ApiError(400, 'This reset link is invalid, expired, or already used', 'reset_invalid')
  await db.user.update({ where: { id: rec.user.id }, data: { passwordHash: hashPassword(password) } })
  await db.session.updateMany({ where: { userId: rec.user.id }, data: { revokedAt: new Date() } })
  await audit({
    orgId: rec.user.orgId, actorType: 'user', actorId: rec.user.id,
    action: 'member.password_reset', entity: 'user', entityId: rec.user.id, meta: {},
  })
  return { email: rec.user.email }
}

/** Change your own password (current password required). */
export async function changeOwnPassword(
  userId: string,
  orgId: string,
  input: { currentPassword: string; newPassword: string }
): Promise<number> {
  if (input.newPassword.length < 8 || input.newPassword.length > 200) {
    throw new ApiError(422, 'The new password must be 8 to 200 characters', 'bad_password')
  }
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, orgId: true, passwordHash: true } })
  if (!user || user.orgId !== orgId) throw new ApiError(404, 'Account not found', 'not_found')
  const { verifyPassword } = await import('@/lib/crypto')
  if (!verifyPassword(input.currentPassword, user.passwordHash)) {
    throw new ApiError(401, 'Your current password is not correct', 'bad_password')
  }
  await db.user.update({ where: { id: userId }, data: { passwordHash: hashPassword(input.newPassword) } })

  // Every session of the account (including the current one) is revoked: a
  // password change must invalidate cookies that were issued for the old one.
  const res = await db.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
  await audit({
    orgId, actorType: 'user', actorId: userId,
    action: 'member.password_changed', entity: 'user', entityId: userId, meta: { sessionsRevoked: res.count },
  })
  return res.count
}
