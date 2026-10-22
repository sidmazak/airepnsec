import { DOMParser } from '@xmldom/xmldom'
import * as saml from 'samlify'
import type { SamlConfig } from './sso'
import { assertOutboundUrl } from '../security/outbound.ts'

/**
 * SAML 2.0 service-provider helpers.
 *
 * The identity provider's response is always signature-verified by samlify
 * against the certificate held in the organisation's SAML configuration — an
 * unsigned or wrongly signed assertion is rejected, never trusted.
 *
 * samlify is CommonJS and pulls in node-only modules, so it is imported
 * lazily from server routes only.
 */

/**
 * samlify refuses to parse any SAML message until a schema validator is
 * registered. xmldom 0.9 only accepts an `onError` callback — warnings are
 * tolerated, real errors abort the parse (XXE-safe by default).
 */
let validatorInstalled = false
export function ensureSamlSchemaValidator(): void {
  if (validatorInstalled) return
  validatorInstalled = true
  saml.setSchemaValidator({
    validate: async (xml: string): Promise<Document> => {
      const doc = new DOMParser({
        onError: (level: string, message: string) => {
          if (level === 'warning') return
          throw new Error(`SAML XML validation failed: ${message}`)
        },
      }).parseFromString(xml, 'text/xml')
      return doc as unknown as Document
    },
  })
}

ensureSamlSchemaValidator()

const NS_MD = 'urn:oasis:names:tc:SAML:2.0:metadata'
const NS_DS = 'http://www.w3.org/2000/09/xmldsig#'
const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol'
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Strip the PEM armour — metadata carries the bare base64 body. */
export function certToBase64(cert: string): string {
  const trimmed = cert.trim()
  const between = trimmed.includes('-----BEGIN CERTIFICATE-----')
    ? trimmed.replace(/-----BEGIN CERTIFICATE-----/g, '').replace(/-----END CERTIFICATE-----/g, '')
    : trimmed
  return between.replace(/\s+/g, '')
}

/** Metadata of this service provider — the operator hands this to the IdP. */
export function buildSpMetadataXml(config: SamlConfig): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<EntityDescriptor xmlns="${NS_MD}" entityID="${escapeXml(config.entityId)}">`,
    `  <SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="false" protocolSupportEnumeration="${NS_PROTOCOL}">`,
    '    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>',
    `    <AssertionConsumerService Binding="${BINDING_POST}" Location="${escapeXml(config.acsUrl)}" index="0" isDefault="true"/>`,
    '  </SPSSODescriptor>',
    '</EntityDescriptor>',
  ].join('\n')
}

/** Metadata of the identity provider, built from the configured fields. */
export function buildIdpMetadataXml(config: SamlConfig): string {
  const cert = certToBase64(config.idpCertificate)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<EntityDescriptor xmlns="${NS_MD}" entityID="${escapeXml(config.idpEntityId)}">`,
    `  <IDPSSODescriptor protocolSupportEnumeration="${NS_PROTOCOL}">`,
    `    <KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="${NS_DS}"><ds:X509Data><ds:X509Certificate>${cert}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></KeyDescriptor>`,
    '    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>',
    `    <SingleSignOnService Binding="${BINDING_REDIRECT}" Location="${escapeXml(config.idpSsoUrl)}"/>`,
    `    <SingleSignOnService Binding="${BINDING_POST}" Location="${escapeXml(config.idpSsoUrl)}"/>`,
    '  </IDPSSODescriptor>',
    '</EntityDescriptor>',
  ].join('\n')
}

export type SamlEntities = {
  sp: saml.ServiceProviderInstance
  idp: saml.IdentityProviderInstance
}

/** Build the SP/IdP pair from the stored configuration. */
export function buildSamlEntities(config: SamlConfig): SamlEntities {
  const sp = saml.ServiceProvider({
    metadata: buildSpMetadataXml(config),
    wantAssertionsSigned: false,
    wantMessageSigned: false,
    authnRequestsSigned: false,
    isAssertionEncrypted: false,
  })
  const idp = saml.IdentityProvider({
    metadata: config.idpMetadataXml?.trim() ? config.idpMetadataXml : buildIdpMetadataXml(config),
    wantAuthnRequestsSigned: false,
  })
  return { sp, idp }
}

/** Build the redirect URL that starts the SP-initiated SSO flow. */
export function createSamlLoginUrl(config: SamlConfig, relayState: string): { url: string; requestId: string } {
  const { sp, idp } = buildSamlEntities(config)
  const context = sp.createLoginRequest(idp, 'redirect', { relayState })
  return { url: context.context, requestId: context.id }
}

export type SamlParseResult =
  | {
      ok: true
      nameId: string
      attributes: Record<string, unknown>
      issuer: string
      inResponseTo?: string
    }
  | { ok: false; reason: string }

/**
 * Validate a SAMLResponse and return the asserted identity.
 * The signature check happens inside samlify — a failure throws and is
 * reported as a rejection.
 */
export async function parseSamlLoginResponse(
  config: SamlConfig,
  body: Record<string, unknown>,
  options?: { inResponseTo?: string }
): Promise<SamlParseResult> {
  let samlResponse = body.SAMLResponse
  if (typeof samlResponse !== 'string' || !samlResponse.trim()) {
    return { ok: false, reason: 'The identity provider did not send a SAML response.' }
  }
  // Form-urlencoded parsing converts '+' to space; restore it (base64 never contains spaces).
  samlResponse = samlResponse.replace(/\s+/g, '+')
  try {
    const { sp, idp } = buildSamlEntities(config)
    const result = await sp.parseLoginResponse(idp, 'post', { body: { ...body, SAMLResponse: samlResponse } }, options)
    const extract = result.extract ?? {}
    const attributes: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(extract.attributes ?? {})) {
      attributes[key] = value
    }
    const nameId = String(extract.nameID ?? '')
    if (nameId) attributes['nameId'] = nameId
    const issuerRaw = extract.issuer
    const issuer = Array.isArray(issuerRaw) ? String(issuerRaw[0] ?? '') : String(issuerRaw ?? '')
    const inResponseToRaw = extract.response?.inResponseTo
    const inResponseTo = Array.isArray(inResponseToRaw) ? String(inResponseToRaw[0] ?? '') : String(inResponseToRaw ?? '')
    return { ok: true, nameId, attributes, issuer, inResponseTo }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'The SAML response could not be verified.'
    return { ok: false, reason: message.slice(0, 300) }
  }
}

/**
 * Fetch and parse IdP metadata from a URL. Resolves the entityID, SSO endpoint,
 * and signing certificate. SSRF-guarded via assertOutboundUrl.
 */
export async function fetchAndParseIdpMetadata(
  metadataUrl: string
): Promise<{ entityId: string; ssoUrl: string; certificate: string }> {
  const allowedUrl = await assertOutboundUrl(metadataUrl, { label: 'IdP metadata URL' })
  const res = await fetch(allowedUrl.toString(), { headers: { accept: 'application/samlmetadata+xml,application/xml' } })
  if (!res.ok) throw new Error(`Failed to fetch IdP metadata: ${res.status} ${res.statusText}`)
  const xml = await res.text()
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  const entityDescriptor = doc.documentElement
  if (!entityDescriptor) throw new Error('IdP metadata XML is empty')
  const entityId = entityDescriptor.getAttribute('entityID') ?? ''
  if (!entityId) throw new Error('IdP metadata missing entityID')

  const idpSsoDescriptorList = [...entityDescriptor.getElementsByTagName('IDPSSODescriptor')]
  const idpSsoDescriptor = idpSsoDescriptorList[0]
  if (!idpSsoDescriptor) throw new Error('IdP metadata missing IDPSSODescriptor')

  // Find SingleSignOnService with HTTP-Redirect or HTTP-POST binding
  const ssoServices = [...idpSsoDescriptor.getElementsByTagName('SingleSignOnService')]
  const redirectBinding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
  const postBinding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST'
  let ssoUrl = ''
  for (const svc of ssoServices) {
    const binding = svc.getAttribute('Binding') ?? ''
    if (binding === redirectBinding || binding === postBinding) {
      ssoUrl = svc.getAttribute('Location') ?? ''
      if (ssoUrl) break
    }
  }
  if (!ssoUrl) throw new Error('IdP metadata missing SingleSignOnService with Redirect/POST binding')

  // Find X509Certificate in KeyDescriptor[use="signing"]
  const keyDescriptors = [...idpSsoDescriptor.getElementsByTagName('KeyDescriptor')]
  let certificate = ''
  for (const kd of keyDescriptors) {
    if (kd.getAttribute('use') !== 'signing') continue
    const x509Certs = [...kd.getElementsByTagName('X509Certificate')]
    if (x509Certs.length > 0) {
      certificate = x509Certs[0].textContent?.trim() ?? ''
      if (certificate) break
    }
  }
  if (!certificate) throw new Error('IdP metadata missing signing certificate')

  return { entityId, ssoUrl, certificate }
}
