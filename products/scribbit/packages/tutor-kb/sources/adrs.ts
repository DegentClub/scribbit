/**
 * Short, authored summaries of the estate Architecture Decision Records the tutor is most often asked about.
 * These are OUR one-paragraph summaries (labelled `authored`), each citing the ADR file so a reader can read
 * the full decision. They let the tutor answer "why does scribb.it sign reveals this way / why non-custodial /
 * why signet" from a grounded, cited source instead of guessing.
 */
import type { AuthoredSource } from './bips.js';

const REPO = 'https://github.com/DegentClub/scribbit/blob/main/docs/adr';

export const ADR_SOURCES: readonly AuthoredSource[] = Object.freeze([
  {
    id: 'adr-0002',
    title: 'ADR-0002 — Non-custodial, parent-linked, block-sized mint',
    url: `${REPO}/0002-degent-mint-architecture.md`,
    tags: ['custody', 'non-custodial', 'mint', 'reveal', 'psbt', 'policy'],
    text:
      'The estate mint architecture is non-custodial: libraries and services never hold a user’s private key. ' +
      'The user generates an ephemeral reveal key in their own environment, funds the commit address, and builds ' +
      'a half-signed reveal PSBT; the service only attaches the parent input and broadcasts. A server therefore ' +
      'never asks for or accepts a seed or private key. This is the security model the tutor points to when asked ' +
      'about signing, keys or what a service can change.',
  },
  {
    id: 'adr-0009',
    title: 'ADR-0009 — Signet Playground: throwaway keys on signet, proof of work, five-minute target',
    url: `${REPO}/0009-signet-playground.md`,
    tags: ['signet', 'playground', 'learn', 'faucet', 'products'],
    text:
      'The Signet Playground lets a stranger with no wallet and no bitcoin make a real inscription on signet, ' +
      'where mistakes cost nothing. It uses signet only (never mainnet), an optional throwaway browser key that ' +
      'never leaves the device, and a proof-of-work faucet instead of a captcha. The point is to learn the ' +
      'commit/reveal flow safely; the same explanatory words are served to agents by the MCP server. It is the ' +
      'place the tutor sends people who want to try inscribing without risk.',
  },
  {
    id: 'adr-0012',
    title: 'ADR-0012 — Ask Blockspace: retrieval-grounded tutor, provider-agnostic ChatPort, extractive fallback',
    url: `${REPO}/0012-ask-blockspace-retrieval-grounded-tutor.md`,
    tags: ['tutor', 'retrieval', 'guardrails', 'grounding', 'policy'],
    text:
      'Ask Blockspace answers blockspace questions grounded in a committed knowledge base with citations, never ' +
      'by free generation. Generation is a provider-agnostic ChatPort with a deterministic extractive fallback ' +
      'that returns matching passages verbatim, so the service works with no model configured. It refuses ' +
      'price/investment questions and any request for keys or mainnet signing, treats retrieved text as data ' +
      '(prompt-injection resistant), and says it is not sure rather than guess when retrieval is weak.',
  },
]);
