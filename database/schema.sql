-- SQLite schema for importing Tier 0 external exact-variant evidence and the
-- three independently generated phenotype/disease tier files.
-- Pipe-delimited multi-value fields are retained as source evidence and can be
-- normalized into child tables after import if the production database needs it.

-- One row states which human and mouse variants/alleles are being compared.
-- Evidence from several routes is attached below instead of duplicating this row.
CREATE TABLE variant_pair (
  pair_id TEXT PRIMARY KEY,
  human_gene TEXT NOT NULL,
  human_variant_id TEXT NOT NULL,
  mouse_gene TEXT NOT NULL,
  mouse_variant_or_allele_id TEXT NOT NULL,
  human_ncbi_gene_id TEXT,
  mouse_ncbi_gene_id TEXT,
  mgi_marker_id TEXT,
  ortholog_source TEXT NOT NULL,
  UNIQUE (human_gene, human_variant_id, mouse_gene, mouse_variant_or_allele_id)
);

-- One row states one reason that a pair is connected. Empty fields are allowed
-- because each route has a different evidence type (ontology, disease ID,
-- semantic score, or direct Tier 0 correspondence).
CREATE TABLE connection_evidence (
  evidence_id INTEGER PRIMARY KEY,
  pair_id TEXT NOT NULL REFERENCES variant_pair(pair_id),
  route_id TEXT NOT NULL,
  human_phenotype_id TEXT,
  human_phenotype_label TEXT,
  mouse_phenotype_id TEXT,
  mouse_phenotype_label TEXT,
  ontology_predicate TEXT,
  shared_disease_id TEXT,
  match_level TEXT,
  score REAL,
  evidence_class TEXT,
  source_dataset TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  review_flag TEXT,
  evidence_detail TEXT
);

CREATE TABLE tier_catalog (
  tier_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  connection_basis TEXT NOT NULL,
  output_file TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  interpretation TEXT NOT NULL
);

CREATE TABLE tier_validation (
  control_id TEXT NOT NULL,
  tier_id TEXT NOT NULL,
  expected TEXT NOT NULL,
  found_rows INTEGER NOT NULL,
  within_tier_support TEXT,
  status TEXT NOT NULL,
  interpretation TEXT NOT NULL,
  PRIMARY KEY (control_id, tier_id)
);

-- Tier 0 is supplied by a collaborator and is intentionally independent of
-- phenotype evidence. Only rows with qc_status='passed' should enter the
-- production Tier 0 view. The exact-match definition and all coordinate-system
-- versions must remain attached to every row.
CREATE TABLE tier0_exact_variant (
  tier_id TEXT NOT NULL CHECK (tier_id = 'tier0'),
  connection_basis TEXT NOT NULL CHECK (connection_basis = 'exact_variant_correspondence'),
  match_level TEXT NOT NULL CHECK (match_level IN (
    'genomic_reciprocal_exact', 'coding_exact', 'protein_exact'
  )),
  exact_match_definition TEXT NOT NULL,
  human_gene TEXT NOT NULL,
  human_ncbi_gene_id TEXT,
  human_hgnc_id TEXT,
  human_variant_id TEXT NOT NULL,
  human_assembly TEXT NOT NULL,
  human_chromosome TEXT,
  human_position TEXT,
  human_reference_allele TEXT,
  human_alternate_allele TEXT,
  human_transcript TEXT,
  human_hgvs_c TEXT,
  human_hgvs_p TEXT,
  mouse_gene TEXT NOT NULL,
  mouse_ncbi_gene_id TEXT,
  mgi_marker_id TEXT,
  mouse_variant_id TEXT NOT NULL,
  mouse_assembly TEXT NOT NULL,
  mouse_chromosome TEXT,
  mouse_position TEXT,
  mouse_reference_allele TEXT,
  mouse_alternate_allele TEXT,
  mouse_transcript TEXT,
  mouse_hgvs_c TEXT,
  mouse_hgvs_p TEXT,
  ortholog_source TEXT NOT NULL,
  cross_species_alignment_source TEXT NOT NULL,
  alignment_version TEXT NOT NULL,
  allele_orientation TEXT NOT NULL CHECK (allele_orientation IN ('forward', 'reverse_complement')),
  reciprocal_mapping INTEGER NOT NULL CHECK (reciprocal_mapping IN (0, 1)),
  qc_status TEXT NOT NULL CHECK (qc_status IN ('pending', 'passed', 'rejected')),
  source_dataset TEXT NOT NULL,
  source_version TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  source_url TEXT,
  source_sha256 TEXT NOT NULL,
  license TEXT,
  contributor TEXT,
  notes TEXT,
  PRIMARY KEY (source_dataset, source_version, source_record_id)
);

CREATE TABLE tier1_monarch_phenotype (
  tier_id TEXT, connection_basis TEXT, human_gene TEXT, human_ncbi_gene_id TEXT,
  rs_id TEXT, clinvar_variation_id TEXT, chromosome TEXT, position TEXT,
  reference_allele TEXT, alternate_allele TEXT, clinical_significance TEXT,
  review_status TEXT, disease_id TEXT, disease_name TEXT, hpo_id TEXT,
  hpo_label TEXT, hpo_annotation_evidence TEXT, hpo_annotation_reference TEXT,
  hpo_frequency TEXT, hpo_biocuration TEXT, predicate TEXT,
  mapping_confidence TEXT, mapping_justification TEXT, mapping_date TEXT,
  mapping_source TEXT, mp_id TEXT, mp_label TEXT, mouse_gene TEXT,
  mouse_ncbi_gene_id TEXT, mgi_marker_id TEXT, allelic_composition TEXT,
  mouse_allele TEXT, mgi_allele_id TEXT, genetic_background TEXT,
  mouse_pubmed_ids TEXT, mgi_genotype_id TEXT, ortholog_source TEXT
);

CREATE TABLE tier2_ortholog_phenotype (
  tier_id TEXT, connection_basis TEXT, human_gene TEXT, human_ncbi_gene_id TEXT,
  rs_id TEXT, human_variant_source TEXT, human_source_record_id TEXT,
  human_chromosome TEXT, human_position TEXT, human_phenotype_id TEXT,
  human_phenotype_label TEXT, human_evidence_class TEXT,
  human_evidence_detail TEXT, human_p_value TEXT, human_publication_id TEXT,
  human_clinical_significance TEXT, mouse_gene TEXT, mouse_ncbi_gene_id TEXT,
  mgi_marker_id TEXT, mouse_allele TEXT, mgi_allele_id TEXT, allele_name TEXT,
  allele_type TEXT, allelic_composition TEXT, genetic_background TEXT,
  mouse_phenotype_id TEXT, mouse_phenotype_label TEXT,
  mouse_phenotype_definition TEXT, mouse_phenotype_source TEXT,
  mouse_evidence_detail TEXT, mouse_pubmed_ids TEXT, mgi_genotype_id TEXT,
  ortholog_source TEXT, within_tier_support TEXT, match_method TEXT,
  matched_concept TEXT, shared_informative_tokens TEXT, token_jaccard TEXT,
  interpretation TEXT
);

CREATE TABLE tier3_disease_model (
  tier_id TEXT, connection_basis TEXT, human_gene TEXT, human_ncbi_gene_id TEXT,
  rs_id TEXT, human_variant_source TEXT, human_source_record_id TEXT,
  human_chromosome TEXT, human_position TEXT, human_condition_label TEXT,
  human_condition_identifiers TEXT, human_evidence_class TEXT,
  human_clinical_significance TEXT, mouse_gene TEXT, mouse_ncbi_gene_id TEXT,
  mgi_marker_id TEXT, mouse_allele TEXT, mgi_allele_id TEXT,
  mouse_allele_name TEXT, mouse_allele_attribute TEXT,
  allelic_composition TEXT, genetic_background TEXT, mgi_genotype_id TEXT,
  shared_disease_id TEXT, mouse_doid TEXT, mouse_omim_ids TEXT,
  mouse_mp_ids TEXT, mouse_pubmed_ids TEXT, ortholog_source TEXT,
  interpretation TEXT
);

CREATE INDEX IF NOT EXISTS idx_tier_validation_tier ON tier_validation(tier_id, status);
CREATE INDEX IF NOT EXISTS idx_variant_pair_human ON variant_pair(human_gene, human_variant_id);
CREATE INDEX IF NOT EXISTS idx_variant_pair_mouse ON variant_pair(mouse_gene, mouse_variant_or_allele_id);
CREATE INDEX IF NOT EXISTS idx_connection_evidence_pair_route ON connection_evidence(pair_id, route_id);
CREATE INDEX IF NOT EXISTS idx_tier0_human_variant ON tier0_exact_variant(human_gene, human_variant_id);
CREATE INDEX IF NOT EXISTS idx_tier0_mouse_variant ON tier0_exact_variant(mouse_gene, mouse_variant_id);
CREATE INDEX IF NOT EXISTS idx_tier0_match_qc ON tier0_exact_variant(match_level, qc_status);
CREATE INDEX IF NOT EXISTS idx_tier1_human_variant ON tier1_monarch_phenotype(human_gene, rs_id);
CREATE INDEX IF NOT EXISTS idx_tier1_mouse_allele ON tier1_monarch_phenotype(mouse_gene, mgi_allele_id);
CREATE INDEX IF NOT EXISTS idx_tier2_human_variant ON tier2_ortholog_phenotype(human_gene, rs_id);
CREATE INDEX IF NOT EXISTS idx_tier2_mouse_allele ON tier2_ortholog_phenotype(mouse_gene, mgi_allele_id);
CREATE INDEX IF NOT EXISTS idx_tier2_support ON tier2_ortholog_phenotype(within_tier_support, match_method);
CREATE INDEX IF NOT EXISTS idx_tier3_human_variant ON tier3_disease_model(human_gene, rs_id);
CREATE INDEX IF NOT EXISTS idx_tier3_mouse_allele ON tier3_disease_model(mouse_gene, mgi_allele_id);
CREATE INDEX IF NOT EXISTS idx_tier3_disease ON tier3_disease_model(shared_disease_id);

CREATE VIEW IF NOT EXISTS active_tier0_exact_variant AS
SELECT *
FROM tier0_exact_variant
WHERE qc_status = 'passed';
