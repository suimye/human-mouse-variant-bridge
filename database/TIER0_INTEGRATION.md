# Tier 0 integration contract

Tier 0 is the collaborator-supplied route for direct human–mouse variant correspondence. It is independent of phenotype matching and is stored as one additional `connection_evidence` route for the same logical variant pair used by Tier 1–3 and Semantic.

## Why “exact” needs a recorded subtype

Human and mouse do not share a coordinate system, so “the same variant” is not self-defining. Every Tier 0 row must state one `match_level` and a machine- and human-readable `exact_match_definition`.

| `match_level` | Required meaning | Typical use |
| --- | --- | --- |
| `genomic_reciprocal_exact` | The complete normalized REF/ALT interval maps reciprocally between fixed human and mouse assemblies, and the alleles match after strand normalization | Strongest genome-level direct correspondence |
| `coding_exact` | A versioned transcript/CDS alignment maps the same normalized coding-nucleotide edit | Coding variants when genome-level alignment is not the claimed basis |
| `protein_exact` | A versioned protein alignment maps the same reference residue(s) and the same amino-acid change | Protein-altering variants; does not cover synonymous or noncoding changes |

These are subtypes of Tier 0, not three new phenotype Tiers. The default display should show the subtype and must not collapse them into an unexplained “exact” flag.

## Files

- Exchange header: `data/external/tier0_exact_variant.template.tsv`
- Row contract: `config/tier0-exact-variant.schema.json`
- Validator: `npm run validate:tier0 -- path/to/collaborator.normalized.tsv`
- SQLite destination: `tier0_exact_variant` in `database/schema.sql`
- Production view: `active_tier0_exact_variant` (`qc_status = 'passed'` only)

The collaborator’s original file should be retained unchanged outside version control. Record its filename, byte size, SHA-256, release/version label, license, and contributor. A normalized derivative can then be created with the template header.

## Pre-load QC

1. Confirm that the human and mouse genes form an accepted 1:1 ortholog pair, and retain the ortholog source/version.
2. Require explicit human and mouse assemblies. Validate each REF allele against its stated reference assembly and left-normalize alleles before comparison.
3. Normalize strand orientation and record whether reverse complementation was required.
4. For `genomic_reciprocal_exact`, reject ambiguous or one-way mappings and require `reciprocal_mapping = 1`.
5. For transcript/protein claims, require versioned transcript or protein alignment identifiers and preserve HGVS on both sides.
6. Require a reproducible `exact_match_definition`, alignment source/version, source record ID, and 64-character SHA-256.
7. Keep failed or unresolved rows with `qc_status = rejected` or `pending`; only `passed` rows enter Tier 0 production queries.

## Merge rule

Create one stable `variant_pair` key from normalized human variant identity, normalized mouse variant/allele identity, and the ortholog pair. Attach Tier 0 as route `tier0_exact_variant`. If the same pair also appears in Tier 1, Tier 2, Tier 3, or Semantic, add those as separate evidence rows instead of replacing Tier 0 or duplicating the pair.

This supports two distinct queries:

- **direct correspondence:** Tier 0 passed rows, whether or not phenotype evidence exists;
- **direct correspondence with functional support:** Tier 0 passed rows that also have one or more phenotype/disease evidence routes.

## Current status

The interface and database destination are defined, but the collaborator file has not been supplied or quality-controlled in this workspace. Therefore Tier 0 is not included in the current row counts, `tier_catalog.tsv`, validation matrix, or the 3/3 case-study result. Those outputs should be regenerated only after the real file passes the checks above.
