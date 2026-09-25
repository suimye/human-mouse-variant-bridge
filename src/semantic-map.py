#!/usr/bin/env python3
"""Ortholog-first embedding baseline; normalized tables avoid variant cartesian products."""
import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import re
import sqlite3
import time

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
AUDITS = [
    ('hearing_paraphrase', 'hearing loss', 'hearing impairment', 'related_example'),
    ('glucose_paraphrase', 'increased blood glucose level', 'elevated blood glucose concentration', 'related_example'),
    ('opposite_glucose', 'increased blood glucose level', 'decreased blood glucose level', 'opposite_direction'),
    ('different_stimulus', 'decreased response to acoustic stimulation', 'decreased response to tactile stimulation', 'different_target'),
    ('unrelated_organ', 'abnormal heart morphology', 'abnormal kidney morphology', 'different_organ'),
    ('negation', 'hearing loss', 'no hearing loss', 'negated'),
]
PAIR_COLUMNS = [
    'match_id', 'human_gene', 'mouse_gene', 'human_text_id', 'mouse_text_id',
    'human_phenotype_label', 'mouse_phenotype_label', 'cosine_similarity',
    'cosine_class', 'retrieval_rank', 'mouse_texts_in_gene', 'human_direction',
    'mouse_direction', 'direction_conflict', 'negation_flag', 'review_status',
    'human_text_truncated', 'mouse_text_truncated', 'model_id', 'model_revision', 'ortholog_source',
    'eligible_for_default_use'
]
DB_PAIR_COLUMNS = [name for name in PAIR_COLUMNS if name not in {
    'human_phenotype_label', 'mouse_phenotype_label', 'model_id', 'model_revision', 'ortholog_source'
}]
HUMAN_COLUMNS = ['evidence_id', 'human_gene', 'human_ncbi_gene_id', 'rs_id',
                 'variant_source', 'source_record_id', 'text_id', 'phenotype_id',
                 'evidence_class', 'publication_id', 'curated_input', 'source_row',
                 'chromosome', 'position', 'reference_allele', 'alternate_allele',
                 'evidence_detail', 'p_value', 'clinical_significance', 'condition_identifiers',
                 'reported_genes', 'mapped_genes']
MOUSE_COLUMNS = ['evidence_id', 'mouse_gene', 'mgi_allele_id', 'mgi_genotype_id',
                 'genetic_background', 'text_id', 'phenotype_id', 'phenotype_source',
                 'pubmed_ids', 'mouse_allele', 'source_row', 'mouse_ncbi_gene_id',
                 'mgi_marker_id', 'allele_name', 'allele_type', 'allelic_composition',
                 'phenotype_definition', 'evidence_detail']


def clean_text(value):
    return ' '.join(str(value or '').split())


def phenotype_text_id(value):
    return 'PT:' + hashlib.sha256(clean_text(value).encode()).hexdigest()[:24]


def classify_cosine(score, a=0.8, b=0.7, c=0.5):
    if not np.isfinite(score) or not (-1.00001 <= score <= 1.00001):
        raise ValueError('Invalid cosine similarity')
    if not -1 <= c < b < a <= 1:
        raise ValueError('Class thresholds must be disjoint and ordered')
    score = max(-1.0, min(1.0, float(score)))
    return 'A' if score >= a else 'B' if score >= b else 'C' if score >= c else 'D'


def select_candidate_indices(scores, b=0.7, top_k=20):
    """All A/B pairs plus top-k overall neighbors; low scores outside top-k are omitted."""
    if top_k < 0:
        raise ValueError('top_k must not be negative')
    order = np.argsort(-scores, kind='stable')
    selected = set(np.flatnonzero(scores >= b).tolist()) | set(order[:top_k].tolist())
    return [int(i) for i in order if int(i) in selected], order


def cosine_matrix(human, mouse):
    """Validate raw BLAS results before clipping; independently check float64 samples."""
    # Accelerate can leave floating-point exception flags despite finite results.
    # Never trust the suppression alone: reject any non-finite or out-of-range value.
    with np.errstate(all='ignore'):
        scores = human @ mouse.T
    if not np.isfinite(scores).all() or (scores < -1.00001).any() or (scores > 1.00001).any():
        raise RuntimeError('Invalid raw cosine matrix; no non-finite scores may be clipped')
    samples = {(0, 0), (len(human)-1, len(mouse)-1), tuple(np.unravel_index(np.argmax(scores), scores.shape))}
    for i, j in samples:
        reference = float(np.sum(human[i].astype(np.float64) * mouse[j].astype(np.float64)))
        if abs(float(scores[i,j]) - reference) > 1e-5:
            raise RuntimeError('BLAS cosine differs from independent float64 sum')
    return np.clip(scores, -1, 1)


def direction(value):
    tokens = set(re.findall(r'[a-z]+', value.lower()))
    up = bool(tokens & {'increased', 'elevated', 'enhanced', 'greater', 'higher', 'high'})
    down = bool(tokens & {'decreased', 'reduced', 'diminished', 'defective', 'impaired',
                          'blunted', 'lower', 'low', 'absent', 'loss', 'hyporesponsive'})
    return 'mixed' if up and down else 'increased' if up else 'decreased_or_impaired' if down else 'unspecified'


def review_flags(human, mouse, truncated=False):
    hd, md = direction(human), direction(mouse)
    conflict = {hd, md} == {'increased', 'decreased_or_impaired'}
    negation = bool(re.search(r'\b(no|not|without)\b', human.lower() + ' ' + mouse.lower()))
    status = 'direction_conflict' if conflict else 'negation_review' if negation else 'truncation_review' if truncated else 'unreviewed'
    return hd, md, int(conflict), int(negation), status


def tsv_rows(path):
    opener = gzip.open if str(path).endswith('.gz') else open
    with opener(path, 'rt', encoding='utf-8', newline='') as stream:
        yield from csv.DictReader(stream, delimiter='\t')


def tsv_writer(path, columns):
    stream = gzip.open(path, 'wt', encoding='utf-8', newline='', compresslevel=3) if str(path).endswith('.gz') else open(path, 'w', encoding='utf-8', newline='')
    writer = csv.writer(stream, delimiter='\t', lineterminator='\n')
    writer.writerow(columns)
    return stream, writer


def sha256_file(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def collapse_duplicate_orthologs(rows):
    """Same human ID and MGI marker may have multiple source NCBI IDs; retain them all."""
    merged = {}
    for row in rows:
        key = (row['human_ncbi_gene_id'], row['mgi_marker_id'])
        if key not in merged:
            merged[key] = dict(row)
            continue
        existing = merged[key]
        for column in row:
            if column == 'mouse_ncbi_gene_id':
                existing[column] = '|'.join(sorted(set(existing[column].split('|') + row[column].split('|'))))
            elif existing[column] != row[column]:
                raise RuntimeError(f'Ambiguous ortholog source field: {column}')
    result = list(merged.values())
    if len({r['human_gene'] for r in result}) != len(result) or len({r['mouse_gene'] for r in result}) != len(result):
        raise RuntimeError('Ortholog symbols do not uniquely identify stable gene pairs')
    return result


def initialize_database(path):
    connection = sqlite3.connect(path)
    connection.execute('PRAGMA journal_mode=OFF')
    connection.execute('PRAGMA synchronous=OFF')
    connection.executescript('''
      CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE ortholog(human_gene TEXT PRIMARY KEY, human_ncbi_gene_id TEXT,
        human_ensembl_gene_id TEXT, hgnc_id TEXT, mouse_gene TEXT UNIQUE,
        mouse_ncbi_gene_id TEXT, mgi_marker_id TEXT, source TEXT);
      CREATE TABLE phenotype_text(text_id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE,
        embedding_truncated INTEGER NOT NULL);
    ''')
    for table, columns in [('human_annotation', HUMAN_COLUMNS), ('mouse_annotation', MOUSE_COLUMNS)]:
        definitions = [f'{name} ' + ('INTEGER' if name in {'curated_input', 'source_row'} else 'TEXT') for name in columns]
        definitions[0] += ' PRIMARY KEY'
        definitions.append('FOREIGN KEY(text_id) REFERENCES phenotype_text(text_id)')
        connection.execute(f'CREATE TABLE {table}({", ".join(definitions)})')
    definitions = []
    for name in DB_PAIR_COLUMNS:
        kind = 'REAL' if name == 'cosine_similarity' else 'INTEGER' if name in {
            'retrieval_rank', 'mouse_texts_in_gene', 'direction_conflict', 'negation_flag',
            'human_text_truncated', 'mouse_text_truncated', 'eligible_for_default_use'
        } else 'TEXT'
        definitions.append(f'{name} {kind}' + (' PRIMARY KEY' if name == 'match_id' else ''))
    definitions += ['FOREIGN KEY(human_text_id) REFERENCES phenotype_text(text_id)',
                    'FOREIGN KEY(mouse_text_id) REFERENCES phenotype_text(text_id)',
                    'FOREIGN KEY(human_gene) REFERENCES ortholog(human_gene)']
    connection.execute(f'CREATE TABLE phenotype_match({", ".join(definitions)})')
    return connection


def load_catalogs(connection, output, config):
    paths = {name: ROOT / 'data/processed' / file for name, file in {
        'ortholog': 'ortholog_mapping_enriched.tsv',
        'human': 'human_variant_phenotypes.tsv.gz',
        'mouse': 'mouse_variant_phenotypes.tsv.gz'
    }.items()}
    raw_orthologs = list(tsv_rows(paths['ortholog']))
    orthologs = collapse_duplicate_orthologs(raw_orthologs)
    columns = list(orthologs[0])
    if len({r['human_gene'] for r in orthologs}) != len(orthologs) or len({r['mouse_gene'] for r in orthologs}) != len(orthologs):
        raise RuntimeError('Input ortholog mapping is not one-to-one')
    connection.executemany('INSERT INTO ortholog VALUES (' + ','.join('?' for _ in columns) + ')',
                           [[r[c] for c in columns] for r in orthologs])
    stream, writer = tsv_writer(output / 'gene_gene_ortholog.tsv', columns)
    writer.writerows([[r[c] for c in columns] for r in orthologs]); stream.close()
    human_genes = {r['human_gene'] for r in orthologs}
    mouse_genes = {r['mouse_gene'] for r in orthologs}
    texts, usage = {}, defaultdict(set)
    gene_texts = {'human': defaultdict(set), 'mouse': defaultdict(set)}
    gene_counts = {'human': Counter(), 'mouse': Counter()}
    stats = {'ortholog_source_rows':len(raw_orthologs), 'unique_ortholog_pairs':len(orthologs),
             'collapsed_same_identity_rows':len(raw_orthologs)-len(orthologs)}
    excluded = {s.lower() for s in config['excluded_placeholder_labels']}
    workflow_config = json.loads((ROOT / 'config/workflow.json').read_text())
    included = set(workflow_config['ortholog_first_mapping']['included_human_evidence_classes'])

    def add_text(value, category):
        value = clean_text(value); identifier = phenotype_text_id(value)
        if identifier in texts and texts[identifier] != value:
            raise RuntimeError('Phenotype text ID collision')
        texts[identifier] = value; usage[identifier].add(category)
        return identifier

    for species, table, columns in [('human', 'human_annotation', HUMAN_COLUMNS), ('mouse', 'mouse_annotation', MOUSE_COLUMNS)]:
        stream, writer = tsv_writer(output / f'{species}_annotations.tsv.gz', columns)
        batch, scanned, retained, skipped = [], 0, 0, 0
        for row_number, row in enumerate(tsv_rows(paths[species]), 1):
            scanned += 1
            gene, label = row[f'{species}_gene'], clean_text(row['phenotype_label'])
            if not label or label.lower() in excluded or gene not in (human_genes if species == 'human' else mouse_genes) or (species == 'human' and row['evidence_class'] not in included):
                skipped += 1; continue
            identifier = add_text(label, species)
            gene_texts[species][gene].add(identifier); gene_counts[species][gene] += 1
            if species == 'human':
                values = [f'HE:{row_number:010}', gene, row['human_ncbi_gene_id'], row['rs_id'],
                          row['variant_source'], row['source_record_id'], identifier, row['phenotype_id'],
                          row['evidence_class'], row['publication_id'], int(row['evidence_class'] == 'literature_curated'), row_number]
                values += [row[c] for c in HUMAN_COLUMNS[12:]]
            else:
                values = [f'ME:{row_number:010}', gene, row['mgi_allele_id'], row['mgi_genotype_id'],
                          row['genetic_background'], identifier, row['phenotype_id'], row['phenotype_source'],
                          row['pubmed_ids'], row['mouse_allele'], row_number]
                values += [row[c] for c in MOUSE_COLUMNS[11:]]
            writer.writerow(values); batch.append(values); retained += 1
            if len(batch) >= 5000:
                connection.executemany(f'INSERT INTO {table} VALUES ({",".join("?" for _ in columns)})', batch)
                batch.clear()
        connection.executemany(f'INSERT INTO {table} VALUES ({",".join("?" for _ in columns)})', batch)
        stream.close(); connection.commit()
        stats[species] = {'scanned': scanned, 'retained': retained, 'excluded': skipped,
                          'unique_texts': len(set().union(*gene_texts[species].values()))}
        print(f"Catalog {species}: {retained:,} annotations", flush=True)
    for _, human, mouse, _ in AUDITS:
        add_text(human, 'audit'); add_text(mouse, 'audit')
    stats['source_files'] = {name: {'path': str(path.relative_to(ROOT)), 'sha256': sha256_file(path)} for name, path in paths.items()}
    stats['variant_annotation_cartesian_comparisons_avoided'] = sum(gene_counts['human'][r['human_gene']] * gene_counts['mouse'][r['mouse_gene']] for r in orthologs)
    return orthologs, texts, usage, gene_texts, stats


def embed_catalog(texts, config, manifest, device_request='auto'):
    import torch
    import transformers
    from transformers import AutoModel, AutoTokenizer
    identifiers = sorted(texts)
    signature = hashlib.sha256(json.dumps({'texts': [(i, texts[i]) for i in identifiers],
        'model': manifest, 'pooling': config['pooling'], 'max_length': config['max_length']}, sort_keys=True).encode()).hexdigest()
    cache = ROOT / 'data/processed/semantic_embeddings.npy'
    metadata_path = cache.with_suffix('.json')
    if cache.exists() and metadata_path.exists():
        metadata = json.loads(metadata_path.read_text())
        if metadata['signature'] == signature and metadata['sha256'] == sha256_file(cache):
            vectors = np.load(cache)
            if vectors.shape != (len(identifiers), metadata['dimension']):
                raise RuntimeError('Invalid embedding cache shape')
            print(f"Reused {len(identifiers):,} cached embeddings", flush=True)
            return identifiers, vectors, set(metadata['truncated_ids']), metadata
    torch.set_num_threads(4); torch.manual_seed(0)
    device = 'mps' if device_request == 'auto' and torch.backends.mps.is_available() else 'cpu' if device_request == 'auto' else device_request
    model_path = ROOT / 'data/models/sapbert'
    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True, trust_remote_code=False)
    model = AutoModel.from_pretrained(model_path, local_files_only=True, trust_remote_code=False).to(device).eval()
    labels = [texts[i] for i in identifiers]
    token_lengths = [len(x) for x in tokenizer(labels, truncation=False)['input_ids']]
    truncated = {identifiers[i] for i, n in enumerate(token_lengths) if n > config['max_length']}
    order = sorted(range(len(labels)), key=lambda i: token_lengths[i])
    vectors = np.empty((len(labels), model.config.hidden_size), dtype=np.float32)
    batch_size, start = config['batch_size'], time.time()
    print(f"Embedding {len(labels):,} unique texts on {device}; truncation flags: {len(truncated)}", flush=True)
    with torch.inference_mode():
        for offset in range(0, len(order), batch_size):
            indices = order[offset:offset + batch_size]
            batch = tokenizer([labels[i] for i in indices], padding=True, truncation=True,
                              max_length=config['max_length'], return_tensors='pt')
            result = model(**{k: v.to(device) for k, v in batch.items()}).last_hidden_state[:, 0, :]
            vectors[indices] = result.cpu().numpy()
            if offset == 0 or offset // batch_size % 25 == 0 or offset + batch_size >= len(order):
                print(f"Embeddings {min(offset + batch_size, len(order)):,}/{len(order):,}; {time.time() - start:.1f}s", flush=True)
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    if not np.isfinite(vectors).all() or (norms <= 0).any():
        raise RuntimeError('Invalid embedding vectors')
    vectors /= norms
    np.save(cache, vectors)
    metadata = {'signature': signature, 'sha256': sha256_file(cache), 'dimension': vectors.shape[1],
                'device': device, 'torch_version': torch.__version__, 'transformers_version': transformers.__version__,
                'truncated_ids': sorted(truncated), 'max_token_length': max(token_lengths),
                'model_id': manifest['model_id'], 'model_revision': manifest['revision'],
                'pooling': config['pooling'], 'max_length': config['max_length'],
                'seconds': round(time.time() - start, 2), 'seed': 0}
    metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
    return identifiers, vectors, truncated, metadata


def write_matches(connection, output, orthologs, texts, gene_texts, ids, embeddings, truncated, config, manifest):
    positions = {identifier: index for index, identifier in enumerate(ids)}
    writers = {grade: tsv_writer(output / f'phenotype_pairs_class_{grade}.tsv.gz', PAIR_COLUMNS) for grade in 'ABCD'}
    counts, review_counts, active_review_counts, compared, gene_pairs, batch = Counter(), Counter(), Counter(), 0, 0, []
    for ortholog in sorted(orthologs, key=lambda row: row['human_gene']):
        hg, mg = ortholog['human_gene'], ortholog['mouse_gene']
        human_ids = sorted(gene_texts['human'].get(hg, [])); mouse_ids = sorted(gene_texts['mouse'].get(mg, []))
        if not human_ids or not mouse_ids:
            continue
        gene_pairs += 1
        scores = cosine_matrix(embeddings[[positions[i] for i in human_ids]], embeddings[[positions[i] for i in mouse_ids]])
        compared += scores.size
        for row_index, human_id in enumerate(human_ids):
            selected, order = select_candidate_indices(scores[row_index], config['class_b_min'], config['low_similarity_top_k_per_human_text_per_ortholog'])
            ranks = np.empty(len(order), dtype=int); ranks[order] = np.arange(1, len(order) + 1)
            for index in selected:
                mouse_id = mouse_ids[index]; score = float(scores[row_index, index]); grade = classify_cosine(score, config['class_a_min'], config['class_b_min'], config['class_c_min'])
                eligible = int(grade in config['default_use_classes'])
                human, mouse = texts[human_id], texts[mouse_id]
                hd, md, conflict, negation, review = review_flags(human, mouse, human_id in truncated or mouse_id in truncated)
                match_id = 'SM:' + hashlib.sha256('|'.join([hg, mg, human_id, mouse_id, manifest['revision']]).encode()).hexdigest()[:24]
                record = dict(zip(PAIR_COLUMNS, [match_id, hg, mg, human_id, mouse_id, human, mouse,
                    score, grade, int(ranks[index]), len(mouse_ids), hd, md, conflict, negation, review,
                    int(human_id in truncated), int(mouse_id in truncated), manifest['model_id'], manifest['revision'], ortholog['source'], eligible]))
                writers[grade][1].writerow([record[c] for c in PAIR_COLUMNS])
                batch.append([record[c] for c in DB_PAIR_COLUMNS]); counts[grade] += 1; review_counts[review] += 1
                if eligible:
                    active_review_counts[review] += 1
                if len(batch) >= 5000:
                    connection.executemany(f'INSERT INTO phenotype_match VALUES ({",".join("?" for _ in DB_PAIR_COLUMNS)})', batch); batch.clear()
        if gene_pairs % 1000 == 0:
            print(f"Mapped {gene_pairs:,} orthologs; {sum(counts.values()):,} text pairs", flush=True)
    connection.executemany(f'INSERT INTO phenotype_match VALUES ({",".join("?" for _ in DB_PAIR_COLUMNS)})', batch)
    for stream, _ in writers.values():
        stream.close()
    connection.commit()
    return {'classes': {g: counts[g] for g in 'ABCD'}, 'review_status': dict(review_counts),
            'default_use_rows':sum(counts[g] for g in config['default_use_classes']),
            'archive_only_rows':counts['D'], 'default_use_review_status':dict(active_review_counts),
            'orthologs_with_both_species_evidence': gene_pairs, 'gene_constrained_text_comparisons': int(compared),
            'omitted_low_similarity_text_pairs': int(compared - sum(counts.values()))}


def finalize_database(connection):
    connection.executescript('''
      CREATE INDEX human_gene_text ON human_annotation(human_gene, text_id);
      CREATE INDEX human_variant ON human_annotation(human_gene, rs_id);
      CREATE INDEX mouse_gene_text ON mouse_annotation(mouse_gene, text_id);
      CREATE INDEX mouse_allele ON mouse_annotation(mouse_gene, mgi_allele_id);
      CREATE INDEX match_gene_text ON phenotype_match(human_gene, human_text_id, mouse_text_id);
      CREATE INDEX match_class ON phenotype_match(cosine_class, review_status);
      CREATE VIEW phenotype_pairs AS SELECT p.*, h.label AS human_phenotype_label,
        m.label AS mouse_phenotype_label FROM phenotype_match p
        JOIN phenotype_text h ON h.text_id=p.human_text_id
        JOIN phenotype_text m ON m.text_id=p.mouse_text_id;
      CREATE VIEW variant_correspondence AS SELECT p.match_id,p.cosine_class,p.cosine_similarity,
        p.review_status,p.direction_conflict,p.negation_flag,p.human_gene,p.mouse_gene,
        h.evidence_id AS human_evidence_id,h.rs_id,h.variant_source,h.evidence_class,
        h.source_record_id,h.chromosome,h.position,h.reference_allele,h.alternate_allele,
        h.phenotype_id AS human_phenotype_id,h.clinical_significance,h.p_value,
        h.curated_input,h.publication_id,m.evidence_id AS mouse_evidence_id,m.mgi_allele_id,
        m.mgi_genotype_id,m.genetic_background,m.mouse_allele,m.phenotype_source,m.pubmed_ids,
        m.phenotype_id AS mouse_phenotype_id,m.mgi_marker_id,m.allele_type,
        p.human_text_id,p.mouse_text_id,p.eligible_for_default_use FROM phenotype_match p
        JOIN human_annotation h ON h.human_gene=p.human_gene AND h.text_id=p.human_text_id
        JOIN mouse_annotation m ON m.mouse_gene=p.mouse_gene AND m.text_id=p.mouse_text_id;
      CREATE VIEW active_phenotype_pairs AS SELECT * FROM phenotype_pairs WHERE eligible_for_default_use=1;
      CREATE VIEW active_variant_correspondence AS SELECT * FROM variant_correspondence WHERE eligible_for_default_use=1;
    ''')
    if connection.execute('PRAGMA foreign_key_check').fetchone() is not None:
        raise RuntimeError('Database has invalid foreign keys')
    if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
        raise RuntimeError('SQLite integrity check failed')
    connection.commit()


def write_audits(connection, output, texts, ids, embeddings, config):
    positions = {identifier: index for index, identifier in enumerate(ids)}
    stream, writer = tsv_writer(output / 'phrase_audit.tsv', ['audit_id', 'human_text', 'mouse_text', 'expected_relation', 'cosine_similarity', 'cosine_class', 'direction_conflict', 'negation_flag', 'review_status'])
    audit_results = []
    for identifier, human, mouse, expected in AUDITS:
        score = float(cosine_matrix(embeddings[[positions[phenotype_text_id(human)]]], embeddings[[positions[phenotype_text_id(mouse)]]])[0,0])
        grade = classify_cosine(score, config['class_a_min'], config['class_b_min'], config['class_c_min']); _, _, conflict, negation, review = review_flags(human, mouse)
        row = [identifier, human, mouse, expected, score, grade, conflict, negation, review]
        writer.writerow(row); audit_results.append(dict(zip(['id','human','mouse','expected','cosine','class','direction_conflict','negation_flag','review'], row)))
    stream.close()
    connection.row_factory = sqlite3.Row
    columns = [r[1] for r in connection.execute('PRAGMA table_info(variant_correspondence)')] + ['human_phenotype_label', 'mouse_phenotype_label']
    result_stream, result_writer = tsv_writer(output / 'control_variant_pairs.tsv.gz', ['control_id'] + columns)
    summaries, failures = [], []
    for control in tsv_rows(ROOT / 'data/controls/positive_controls.tsv'):
        rows = list(connection.execute('''SELECT v.*,h.label AS human_phenotype_label,m.label AS mouse_phenotype_label
          FROM variant_correspondence v JOIN phenotype_text h ON h.text_id=v.human_text_id
          JOIN phenotype_text m ON m.text_id=v.mouse_text_id WHERE v.human_gene=? AND v.rs_id=?
          AND instr('|' || v.mgi_allele_id || '|', '|' || ? || '|')>0 ORDER BY v.cosine_similarity DESC''',
          (control['human_gene'], control['human_variant'], control['mouse_allele_id'])))
        for row in rows:
            result_writer.writerow([control['control_id']] + [row[c] for c in columns])
        counts = Counter(row['cosine_class'] for row in rows)
        active = [r for r in rows if r['eligible_for_default_use']]
        expected = clean_text(control.get('expected_semantic_class'))
        expected_rows = sum(1 for r in active if not r['curated_input'] and r['cosine_class'] == expected) if expected else 0
        status = 'PASS' if not expected or expected_rows else 'FAIL'
        if status == 'FAIL':
            failures.append(f"{control['control_id']} expected semantic class {expected}")
        summaries.append([control['control_id'], control['human_gene'], control['human_variant'], control['mouse_allele_id'],
            counts['A'], counts['B'], counts['C'], counts['D'], max((r['cosine_similarity'] for r in active), default=''),
            sum(r['curated_input'] for r in active), sum(r['direction_conflict'] for r in active), expected,
            expected_rows, status, 'A/B/C default-use candidates from downloaded data; D archive-only; not independent benchmark'])
    result_stream.close()
    columns = ['control_id','human_gene','rs_id','mgi_allele_id','class_A_rows','class_B_rows','class_C_rows','class_D_archive_rows','best_active_cosine','active_curated_input_rows','active_direction_conflict_rows','expected_semantic_class','expected_class_noncurated_rows','semantic_expectation_status','validation_scope']
    stream, writer = tsv_writer(output / 'controls_summary.tsv', columns); writer.writerows(summaries); stream.close()
    if failures:
        raise RuntimeError('; '.join(failures))
    return {'controls': [dict(zip(columns, r)) for r in summaries], 'phrase_audits': audit_results}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--device', default='auto', choices=['auto','cpu','mps']); args = parser.parse_args()
    config = json.loads((ROOT / 'config/workflow.json').read_text())['semantic_mapping']
    classify_cosine(0, config['class_a_min'], config['class_b_min'], config['class_c_min'])
    if config['default_use_classes'] != ['A','B','C']:
        raise RuntimeError('Default-use policy must exclude archive-only D')
    manifest = json.loads((ROOT / 'data/models/sapbert/manifest.json').read_text())
    if manifest['model_id'] != config['model_id']:
        raise RuntimeError('Configured model does not match downloaded model')
    for asset in manifest['files']:
        if sha256_file(ROOT / 'data/models/sapbert' / asset['name']) != asset['sha256']:
            raise RuntimeError(f"Model checksum mismatch: {asset['name']}")
    output = ROOT / 'output/semantic'; output.mkdir(parents=True, exist_ok=True)
    working = output / f'correspondence.{os.getpid()}.working.sqlite'
    connection = initialize_database(working); started = time.time()
    orthologs, texts, usage, gene_texts, preparation = load_catalogs(connection, output, config)
    manual_rows = connection.execute("SELECT count(*) FROM human_annotation WHERE evidence_class='literature_curated'").fetchone()[0]
    if manual_rows:
        raise RuntimeError(f'Manual human literature phenotypes are disabled, found {manual_rows} rows')
    ids, embeddings, truncated, embedding_metadata = embed_catalog(texts, config, manifest, args.device)
    stream, writer = tsv_writer(output / 'phenotype_texts.tsv.gz', ['text_id','phenotype_label','usage','embedding_truncated'])
    for identifier in ids:
        writer.writerow([identifier, texts[identifier], '|'.join(sorted(usage[identifier])), int(identifier in truncated)])
    stream.close()
    connection.executemany('INSERT INTO phenotype_text VALUES (?,?,?)', [(i,texts[i],int(i in truncated)) for i in ids]); connection.commit()
    mapping = write_matches(connection, output, orthologs, texts, gene_texts, ids, embeddings, truncated, config, manifest)
    finalize_database(connection)
    audits = write_audits(connection, output, texts, ids, embeddings, config)
    stats = {'generated_at': datetime.now(timezone.utc).isoformat(), 'config': config, 'model': manifest,
             'preparation': preparation, 'embeddings': embedding_metadata, 'mapping': mapping, 'validation': audits,
             'runtime_packages': {d.metadata['Name']:d.version for d in importlib.metadata.distributions()},
             'seconds': round(time.time() - started, 2), 'validation_scope': 'Illustrative phrase audits and known positive controls only; no held-out calibrated benchmark'}
    connection.executemany('INSERT INTO metadata VALUES (?,?)', [(key,json.dumps(value,ensure_ascii=False)) for key,value in stats.items()]); connection.commit(); connection.close()
    os.replace(working, output / 'correspondence.sqlite')
    stream, writer = tsv_writer(output / 'class_catalog.tsv', ['cosine_class','criterion','phenotype_pair_rows','scope','eligible_for_default_use'])
    writer.writerows([['A',f"{config['class_a_min']} <= cosine <= 1",mapping['classes']['A'],'all above threshold within ortholog',1],
                     ['B',f"{config['class_b_min']} <= cosine < {config['class_a_min']}",mapping['classes']['B'],'all above threshold within ortholog',1],
                     ['C',f"{config['class_c_min']} <= cosine < {config['class_b_min']}",mapping['classes']['C'],f"only top {config['low_similarity_top_k_per_human_text_per_ortholog']} retrieved neighbors within ortholog",1],
                     ['D',f"-1 <= cosine < {config['class_c_min']}",mapping['classes']['D'],'same top-k scope; archive-only; excluded from default use',0]]); stream.close()
    stats['outputs'] = {p.name:{'bytes':p.stat().st_size,'sha256':sha256_file(p)} for p in output.iterdir() if p.is_file() and p.suffix != '.md' and p.name not in {'summary.json','verification.json'} and '.working.' not in p.name}
    (output / 'summary.json').write_text(json.dumps(stats, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'classes':mapping['classes'],'controls':audits['controls'],'seconds':stats['seconds']},ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
