# Preset dependency graph — reference snapshot

Captured 2026-09-02 from Neon dev/main before the preset library was retired
(AEH-242). **Not authoritative and not to be re-seeded.** The presets these
describe are being deleted and the schema reshaped; this survives only as a
sample of the *shape* a real dependency graph takes in our domain, for
designing the edge editor against and for building test fixtures.

Two arrays existed, `requires` (this needs those) and `blocks` (this must
precede those). They were maintained independently and are not mirrors: 35
blocks-only edges, 19 requires-only. Both express the same relation in opposite
directions, which is why AEH-242 collapses them into one directed edge kind.

Shape worth designing for:

    79 active presets, 44 carrying any edge (35 with none)
    88 edges in the union — about 1.3 per node
    heavy fan-in to a few foundations; longest chain 10 deep
    exactly one cycle: P27 -> P34 -> P38 -> P27

That cycle is a genuine data defect and the case the DAG invariant test should
encode: `P27 blocks {P34,P35}` is the suspect edge (identity enforcement gating
payment-provider and shipping config is the odd pairing), but it was never
adjudicated because the library was retired first.

Columns: code | name | requires | blocks | canParallel

    code | name | requires | blocks | canParallel
    P01 | R&D — Contentful & Contentful Studio | {} | {P14,P15,P16,P17,P18,P19,P20,P21} | f
    P02 | R&D — Epicor P21 API | {} | {P07,P08,P09,P24} | f
    P03 | R&D — Celigo | {} | {P07,P08,P09,P10} | f
    P04 | R&D — Klevu | {} | {P11,P12,P13} | f
    P05 | R&D — PIM platform | {} | {P06,P07,P08} | f
    P06 | R&D — Act-On | {} | {P22} | f
    P07 | API gateway & environment setup | {P03} | {P08,P09,P10} | f
    P08 | Celigo flow — B2B identity sync (P21 → Shopify) | {P07,P03,P02} | {P25,P26,P28} | f
    P09 | Celigo flow — pricing & inventory sync (P21 → Shopify) | {P07,P03,P02} | {P25,P26,P27,P28} | f
    P10 | Celigo flow — order submission (Shopify → P21) | {P07,P03,P02} | {} | f
    P11 | PIM product schema definition | {P05} | {P12,P13,P14} | f
    P12 | PIM initial ingestion flow (legacy attribute mapping) | {P11} | {P13} | f
    P13 | PIM data validation & cleansing scripts | {P12} | {P14} | f
    P14 | PIM data fetching & display integration | {P13,P11} | {P27,P30} | f
    P15 | Contentful content model definition | {P01} | {P16,P17,P18,P19,P20,P21} | f
    P16 | Contentful Studio dynamic page rendering | {P15,P01} | {P17,P18,P19,P20} | f
    P17 | CMS component — hero banner (Contentful Studio slice) | {P16} | {} | t
    P18 | CMS component — product grid/teaser (Contentful Studio slice) | {P16} | {} | t
    P19 | CMS component library expansion (8–10 opinionated components) | {P16} | {} | t
    P20 | Contentful Patterns / template pattern library | {P16} | {} | t
    P21 | Lead gen form — non-purchasable SKUs → Act-On | {P06} | {} | t
    P24 | Edge middleware redirect service (90k+ redirects) | {P02} | {} | f
    P25 | URL mapping & validation script | {} | {P24} | f
    P26 | Shopify customer account auth flow | {P08} | {P27,P28,P29,P30,P31} | f
    P27 | Buyer identity enforcement at checkout | {P26,P08} | {P32,P33,P34,P35} | f
    P28 | Contextual pricing via @inContext GraphQL | {P09,P08} | {P29} | t
    P29 | Controlled pricing display feature toggle | {P28} | {} | t
    P30 | Real-time inventory lookup (Shopify API) | {P09,P26} | {} | t
    P31 | Company location selector UI | {P08,P26} | {P27} | t
    P32 | B2B cart logic extensions (quantity rules / volume pricing) | {P09,P27} | {} | f
    P33 | B2B account dashboard (P21 order history + documents) | {P26,P02} | {} | t
    P34 | Shopify payment provider config | {P07} | {P35} | f
    P35 | Shopify shipping zones & carrier rates | {P34} | {} | t
    P36 | Shopify tax configuration | {P34} | {} | t
    P37 | Google Merchant Center (GMC) feed setup | {P09} | {} | t
    P38 | Shopify checkout settings (account-required + branding) | {P34} | {P27,P39,P40} | f
    P39 | Headless cart → Shopify checkout handoff | {P38} | {P40} | f
    P40 | Checkout UI extensions (PO/reference fields + messaging) | {P39} | {} | t
    P41 | Klevu indexing integration (PIM + Contentful) | {P04,P13,P15} | {P42,P43} | f
    P42 | Faceted filtering / PLP interface (Klevu-powered) | {P41} | {} | t
    P43 | Sitewide search — autocomplete, results page & layout | {P41,P15} | {} | t
    P44 | SSR / static generation & Core Web Vitals optimisation | {P16} | {} | t
    P45 | Accessibility implementation (keyboard nav, contrast, focus states) | {P19} | {} | t
