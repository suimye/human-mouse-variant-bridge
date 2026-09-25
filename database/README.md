# Database loading notes

Tier 0 is a pending external input for collaborator-supplied direct human–mouse variant correspondence. Its exchange contract is documented in [`TIER0_INTEGRATION.md`](TIER0_INTEGRATION.md), with the header template in `data/external/tier0_exact_variant.template.tsv`. Do not add Tier 0 to production counts until the real source file has passed the assembly, normalization, reciprocal-mapping, provenance, and license checks.

The three currently generated gzip-compressed TSV files in `output/` are independent phenotype/disease evidence tables. Their first rows exactly match the column order in `schema.sql`.

- `tier1_monarch_phenotype.tsv.gz`: ontology phenotype bridge
- `tier2_ortholog_phenotype.tsv.gz`: ortholog-first phenotype evidence
- `tier3_disease_model.tsv.gz`: shared disease identifier and curated mouse model

`output/tier_catalog.tsv` is the tier dimension and `output/tier_validation_results.tsv` is the positive-control audit table. Load those two tables first, then the evidence tables. Multi-valued source fields use `|` only where the source itself supplies more than one identifier; normalize these into child tables if the production database needs atomic values.

Tier numbers identify independent query strategies, not a universal confidence order. In Tier 2, `within_tier_support` is now `B` for an exact normalized label or `C` for a controlled lexical hypothesis requiring review. Manual human literature phenotypes and the former configured-concept support `A` are disabled.

Tier 0 is different in kind: it is direct sequence/structure correspondence and does not require phenotype evidence. Keep `match_level` (`genomic_reciprocal_exact`, `coding_exact`, or `protein_exact`) visible, because the word “exact” has no reproducible meaning without the coordinate or alignment basis.

## Recommended pair/evidence model

実用検索では、human variantとmouse allele/genotypeの組を`variant_pair`として一意にし、接続根拠を`connection_evidence`の複数行として保持してください。Tierの結果を1行へ潰すと、ontology predicate、共通疾患ID、cosine class、元表現型、出典が失われます。

- `variant_pair`: human gene + rsID、mouse gene + MGI allele/genotype ID、ortholog pair ID
- `connection_evidence`: pair ID、route ID、human/mouse phenotypeまたはdirect-match definition、source record、predicate/shared disease ID/score/class/match level、review flag
- 通常検索: pairを一度だけ表示し、存在するrouteを集約
- 根拠確認: pairからroute別のevidence rowへ展開

`database/schema.sql`にはこの2表を実体として追加しています。例えばCFTRでは`variant_pair`にrs113993960–MGI:1856709を1行だけ保存し、`connection_evidence`へHP:0001508–MP:0001732のTier 1行とOMIM:219700共有のTier 3行を別々に追加します。

`output/semantic/case_study_summary.tsv`はTLR4、CFTR、ALPLについて、この構造で何を取得したいかを示す監査用サマリーです。3例は接続経路の相補性を示すcase studyであり、モデル精度を推定する独立評価集合ではありません。

Tier 0を読み込む際は、同じhuman variant–mouse variant/allele–orthologの組を既存の`variant_pair`へ寄せ、`tier0_exact_variant`という独立evidence routeを追加します。Tier 0があるpairでもTier 1–3/Semanticを上書きせず、逆にphenotype evidenceがないTier 0 pairも保持します。

図は役割ごとに分けています。`output/tier_evidence_explainer.html`はTier 1/2/3の接続原理、`output/case_study_evidence_explainer.html`は3例での対象ペア回収を説明します。
