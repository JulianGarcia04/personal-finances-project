import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DATA_CONTROLLER,
  LEGAL_DOCUMENTS,
  LEGAL_VERSIONS,
  buildLegalConsent,
  hasPendingPlaceholders
} from './legal.ts'

const text = (doc: keyof typeof LEGAL_DOCUMENTS) =>
  LEGAL_DOCUMENTS[doc].sections.map((s) => [s.heading, ...s.paragraphs].join('\n')).join('\n')

test('both documents carry the version users accept', () => {
  assert.match(LEGAL_VERSIONS.terms, /^\d{4}-\d{2}-\d{2}$/)
  assert.match(LEGAL_VERSIONS.privacy, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(LEGAL_DOCUMENTS.terms.version, LEGAL_VERSIONS.terms)
  assert.equal(LEGAL_DOCUMENTS.privacy.version, LEGAL_VERSIONS.privacy)
})

test('privacy policy covers the contents Ley 1581 de 2012 requires', () => {
  const privacy = text('privacy')
  for (const required of [
    /Ley 1581 de 2012/,
    /Responsable del tratamiento/,
    /Finalidades/,
    /Derechos del titular/,
    /conocer, actualizar y rectificar/,
    /revocar la autorización/,
    /Superintendencia de Industria y Comercio/,
    /diez \(10\) días hábiles/,
    /quince \(15\) días hábiles/,
    /fuera de Colombia/,
    /Vigencia/
  ]) {
    assert.match(privacy, required)
  }
  assert.ok(privacy.includes(DATA_CONTROLLER.email), 'policy names the contact channel')
})

test('terms state that the assistant is not financial advice', () => {
  assert.match(text('terms'), /no constituye asesoría financiera/)
})

test('controller fields still in brackets are detected as pending', () => {
  const filled = { name: 'Vault SAS', id: 'NIT 900.000.000-1', address: 'Bogotá', email: 'hola@vault.co' }
  assert.equal(hasPendingPlaceholders(filled), false)
  assert.equal(hasPendingPlaceholders({ ...filled, email: '[CORREO DE ATENCIÓN DE DATOS PERSONALES]' }), true)
})

test('consent records the accepted versions, the method and the given timestamp', () => {
  const acceptedAt = { sentinel: true }
  assert.deepEqual(buildLegalConsent('signup-checkbox', acceptedAt), {
    termsVersion: LEGAL_VERSIONS.terms,
    privacyVersion: LEGAL_VERSIONS.privacy,
    method: 'signup-checkbox',
    acceptedAt
  })
})
