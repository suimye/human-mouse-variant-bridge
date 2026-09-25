# Repository publishing plan

## Recommended repository name

**`human-mouse-variant-bridge`** is the recommended name. It states the scientific object and the cross-species role without implying that TogoVar, Monarch, MGI, or another organization officially owns or endorses the repository.

Alternatives:

- `orthovariant-bridge`: short and distinctive, but less immediately understandable;
- `crossspecies-variant-evidence`: emphasizes the evidence model, but is longer;
- `human-mouse-variant-evidence`: explicit and conservative;
- `TogoVar-MoG-Bridge`: use only if the project owners approve the branding implication.

## Suggested repository scope

Use `2026/` as the repository root. Publish code, tests, configuration, schemas, documentation, figures, HTML explainers, manifests, and small validation summaries. Do not commit downloaded source files, model weights, the local virtual environment, the 1.5-GB SQLite database, large generated TSVs, or the collaborator’s original Tier 0 file.

The `.gitignore` in this directory is prepared for that scope. Large public data products can later be attached as a versioned release or deposited in a suitable data repository after source-specific redistribution terms have been checked.

## Items that must be decided before public upload

1. Hosting service and owner/organization.
2. Public or private visibility.
3. Repository name.
4. Code license and data/documentation license.
5. Whether the source providers permit redistribution of each derived table.
6. Contributor names and citation metadata.

No remote repository should be created until these choices are confirmed. In particular, OMIM-derived HPO annotations and source-derived rows must not be assumed redistributable merely because the pipeline is reproducible.

## Tier 0 release rule

The collaborator’s original file should not be committed. Store it in a controlled location, record its filename, version, byte size, SHA-256, license, and contributor, and create a normalized derivative using `data/external/tier0_exact_variant.template.tsv`. Release only rows with `qc_status=passed`, and only if the collaborator and source licenses permit redistribution.
