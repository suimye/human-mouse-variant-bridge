#!/usr/bin/env python3
"""Read-only numerical, ortholog, export and database checks; emit a verification record."""
from collections import Counter, defaultdict
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/semantic'


def checksum(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    summary = json.loads((OUT / 'summary.json').read_text())
    config = summary['config']
    connection = sqlite3.connect(f'file:{OUT / "correspondence.sqlite"}?mode=ro', uri=True)
    checks = {}
    for name, sql in {
        'class_A_boundary_errors': "SELECT count(*) FROM phenotype_match WHERE cosine_class='A' AND (cosine_similarity<? OR cosine_similarity>1)",
        'class_B_boundary_errors': "SELECT count(*) FROM phenotype_match WHERE cosine_class='B' AND (cosine_similarity<? OR cosine_similarity>=?)",
        'class_C_boundary_errors': "SELECT count(*) FROM phenotype_match WHERE cosine_class='C' AND (cosine_similarity>=? OR cosine_similarity<?)",
        'class_D_boundary_errors': "SELECT count(*) FROM phenotype_match WHERE cosine_class='D' AND (cosine_similarity>=? OR cosine_similarity< -1)",
        'low_similarity_rank_errors': "SELECT count(*) FROM phenotype_match WHERE cosine_class IN ('C','D') AND retrieval_rank>?",
        'default_use_flag_errors': "SELECT count(*) FROM phenotype_match WHERE eligible_for_default_use IS NULL OR eligible_for_default_use NOT IN (0,1) OR eligible_for_default_use != CASE WHEN cosine_class IN ('A','B','C') THEN 1 ELSE 0 END",
        'D_in_active_phenotype_view': "SELECT count(*) FROM active_phenotype_pairs WHERE cosine_class='D'",
        'manual_human_literature_rows': "SELECT count(*) FROM human_annotation WHERE evidence_class='literature_curated' OR variant_source='Literature'",
        'nonortholog_pairs': "SELECT count(*) FROM phenotype_match p LEFT JOIN ortholog o ON p.human_gene=o.human_gene AND p.mouse_gene=o.mouse_gene WHERE o.human_gene IS NULL",
        'human_gene_orphans': "SELECT count(*) FROM human_annotation h LEFT JOIN ortholog o ON h.human_gene=o.human_gene WHERE o.human_gene IS NULL",
        'mouse_gene_orphans': "SELECT count(*) FROM mouse_annotation m LEFT JOIN ortholog o ON m.mouse_gene=o.mouse_gene WHERE o.mouse_gene IS NULL",
        'missing_human_pair_evidence': "SELECT count(*) FROM phenotype_match p WHERE NOT EXISTS(SELECT 1 FROM human_annotation h WHERE h.human_gene=p.human_gene AND h.text_id=p.human_text_id)",
        'missing_mouse_pair_evidence': "SELECT count(*) FROM phenotype_match p WHERE NOT EXISTS(SELECT 1 FROM mouse_annotation m WHERE m.mouse_gene=p.mouse_gene AND m.text_id=p.mouse_text_id)",
    }.items():
        parameters = {
            'class_A_boundary_errors':(config['class_a_min'],),
            'class_B_boundary_errors':(config['class_b_min'],config['class_a_min']),
            'class_C_boundary_errors':(config['class_b_min'],config['class_c_min']),
            'class_D_boundary_errors':(config['class_c_min'],),
            'low_similarity_rank_errors':(config['low_similarity_top_k_per_human_text_per_ortholog'],)
        }.get(name,())
        count = connection.execute(sql, parameters).fetchone()[0]
        checks[name] = count
        if count:
            raise RuntimeError(f'{name}: {count}')
    checks['sqlite_integrity'] = connection.execute('PRAGMA quick_check').fetchone()[0]
    checks['foreign_key_errors'] = len(connection.execute('PRAGMA foreign_key_check').fetchall())
    assert checks['sqlite_integrity'] == 'ok' and checks['foreign_key_errors'] == 0
    print('Database ortholog, class, rank and evidence checks passed', flush=True)

    exported = {}
    for grade in 'ABCD':
        path = OUT / f'phenotype_pairs_class_{grade}.tsv.gz'
        count = 0
        with gzip.open(path, 'rt', newline='') as stream:
            for row in csv.DictReader(stream, delimiter='\t'):
                score = float(row['cosine_similarity'])
                expected = 'A' if score >= config['class_a_min'] else 'B' if score >= config['class_b_min'] else 'C' if score >= config['class_c_min'] else 'D'
                assert np.isfinite(score) and -1 <= score <= 1 and row['cosine_class'] == grade == expected
                assert int(row['eligible_for_default_use']) == int(grade in config['default_use_classes'])
                count += 1
        db_count = connection.execute('SELECT count(*) FROM phenotype_match WHERE cosine_class=?',(grade,)).fetchone()[0]
        assert count == db_count == summary['mapping']['classes'][grade]
        assert checksum(path) == summary['outputs'][path.name]['sha256']
        exported[grade] = count
        print(f'Export class {grade}: {count:,} checked', flush=True)
    active_rows = connection.execute('SELECT count(*) FROM active_phenotype_pairs').fetchone()[0]
    assert active_rows == sum(exported[g] for g in config['default_use_classes']) == summary['mapping']['default_use_rows']
    checks['default_use_rows'] = active_rows
    checks['archive_only_rows'] = exported['D']
    with open(OUT / 'controls_summary.tsv', newline='', encoding='utf-8') as stream:
        control_rows = list(csv.DictReader(stream, delimiter='\t'))
    failed_controls = [r['control_id'] for r in control_rows if r['semantic_expectation_status'] == 'FAIL']
    if failed_controls:
        raise RuntimeError(f'Failed semantic control expectations: {failed_controls}')
    checks['semantic_control_expectations'] = {r['control_id']:r['semantic_expectation_status'] for r in control_rows if r['expected_semantic_class']}

    with gzip.open(OUT / 'phenotype_texts.tsv.gz', 'rt') as stream:
        ids = [r['text_id'] for r in csv.DictReader(stream,delimiter='\t')]
    position = {identifier:i for i,identifier in enumerate(ids)}
    vectors = np.load(ROOT / 'data/processed/semantic_embeddings.npy', mmap_mode='r')
    assert np.isfinite(vectors).all()
    norm_error = float(np.max(np.abs(np.linalg.norm(vectors, axis=1) - 1)))
    assert norm_error < 1e-5
    sample = connection.execute('SELECT human_text_id,mouse_text_id,cosine_similarity FROM phenotype_match ORDER BY match_id LIMIT 1000').fetchall()
    max_error = max(abs(float(score) - float(np.sum(vectors[position[h]].astype(np.float64) * vectors[position[m]].astype(np.float64)))) for h,m,score in sample)
    assert max_error < 1e-5
    checks['independent_float64_score_sample'] = {'rows':len(sample),'maximum_absolute_error':max_error,'maximum_vector_norm_error':norm_error}

    # Verify all above-threshold text pairs are present, not silently top-k capped.
    above = {(h,m,ht,mt) for h,m,ht,mt in connection.execute("SELECT human_gene,mouse_gene,human_text_id,mouse_text_id FROM phenotype_match WHERE cosine_class IN ('A','B')")}
    by_species = {}
    for species in ['human','mouse']:
        genes = defaultdict(set)
        for gene,tid in connection.execute(f'SELECT DISTINCT {species}_gene,text_id FROM {species}_annotation'):
            genes[gene].add(tid)
        by_species[species] = genes
    found, comparisons = set(), 0
    for hg,mg in connection.execute('SELECT human_gene,mouse_gene FROM ortholog'):
        hids, mids = sorted(by_species['human'].get(hg,[])), sorted(by_species['mouse'].get(mg,[]))
        if not hids or not mids:
            continue
        with np.errstate(all='ignore'):
            scores = vectors[[position[i] for i in hids]] @ vectors[[position[i] for i in mids]].T
        assert np.isfinite(scores).all() and np.max(np.abs(scores)) <= 1.00001
        comparisons += scores.size
        for i,j in zip(*np.where(scores >= config['class_b_min'])):
            found.add((hg,mg,hids[i],mids[j]))
    assert found == above
    assert comparisons == summary['mapping']['gene_constrained_text_comparisons']
    checks['above_threshold_completeness'] = {'all_A_B_pairs':len(above),'compared_text_pairs':int(comparisons),'missing':len(found-above),'extra':len(above-found)}
    checks['class_review_flags'] = [dict(zip(['cosine_class','rows','direction_conflict_rows','negation_flag_rows'],r)) for r in connection.execute('SELECT cosine_class,count(*),sum(direction_conflict),sum(negation_flag) FROM phenotype_match GROUP BY cosine_class')]
    assert checksum(OUT / 'correspondence.sqlite') == summary['outputs']['correspondence.sqlite']['sha256']
    record = {'verified_at':datetime.now(timezone.utc).isoformat(),'status':'PASS', 'checks':checks,'export_rows':exported,
              'summary_sha256':checksum(OUT / 'summary.json'), 'validation_scope':'Numerical, export and relational correctness only; not biological accuracy or threshold calibration'}
    (OUT / 'verification.json').write_text(json.dumps(record, indent=2) + '\n')
    print(json.dumps(record,indent=2),flush=True)
    connection.close()


if __name__ == '__main__':
    main()
