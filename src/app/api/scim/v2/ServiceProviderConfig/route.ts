import { NextRequest } from 'next/server'
import { authenticateScimRequest, scimError, scimResponse } from '@/lib/scim'

export const maxDuration = 15

/**
 * GET /api/scim/v2/ServiceProviderConfig
 * Minimal SCIM service provider configuration (RFC 7644 §5).
 */
export async function GET(req: NextRequest) {
  try {
    const auth = await authenticateScimRequest(req)
    if (!auth) return scimError(401, 'A valid SCIM bearer token is required.', 'invalidValue')
    const origin = new URL(req.url).origin
    return scimResponse({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: `${origin}/docs/API.md`,
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: 'oauthbearertoken',
          name: 'OAuth Bearer Token',
          description: 'Authentication token issued by the AI Secretary administrator.',
          primary: true,
        },
      ],
      meta: {
        resourceType: 'ServiceProviderConfig',
        location: `${origin}/api/scim/v2/ServiceProviderConfig`,
      },
    })
  } catch (err) {
    return scimError(500, (err instanceof Error ? err.message : 'The SCIM request failed.').slice(0, 300))
  }
}
