import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location('semantic_map', Path(__file__).parents[1] / 'src/semantic-map.py')
semantic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(semantic)


class SemanticTests(unittest.TestCase):
    def test_threshold_boundaries_are_disjoint(self):
        for score, expected in [(1, 'A'), (.8, 'A'), (.79999, 'B'), (.7, 'B'), (.69999, 'C'), (.5,'C'), (.49999,'D'), (-1, 'D')]:
            self.assertEqual(semantic.classify_cosine(score), expected)

    def test_invalid_scores_and_thresholds(self):
        for score in [np.nan, np.inf, 1.1, -1.1]:
            with self.assertRaises(ValueError):
                semantic.classify_cosine(score)
        with self.assertRaises(ValueError):
            semantic.classify_cosine(.8, a=.7, b=.8)
        with self.assertRaises(ValueError):
            semantic.classify_cosine(.5, c=.7)

    def test_a_and_b_are_not_top_k_capped(self):
        selected, order = semantic.select_candidate_indices(np.array([.9, .85, .8, .75, .7, .6]), top_k=2)
        self.assertEqual(selected, [0, 1, 2, 3, 4])
        self.assertEqual(list(order), [0, 1, 2, 3, 4, 5])

    def test_c_is_only_top_k_overall(self):
        selected, _ = semantic.select_candidate_indices(np.array([.2, .6, .4, .9]), top_k=3)
        self.assertEqual(selected, [3, 1, 2])

    def test_empty_candidates(self):
        selected, _ = semantic.select_candidate_indices(np.array([]))
        self.assertEqual(selected, [])

    def test_cosine_matrix_is_validated_before_clipping(self):
        human = np.array([[1,0],[0,1]], dtype=np.float32)
        mouse = np.array([[1,0],[-1,0]], dtype=np.float32)
        np.testing.assert_allclose(semantic.cosine_matrix(human, mouse), [[1,-1],[0,0]])
        with self.assertRaises(RuntimeError):
            semantic.cosine_matrix(human * 2, mouse)
        with self.assertRaises(RuntimeError):
            semantic.cosine_matrix(human * np.nan, mouse)

    def test_opposite_direction_is_flagged_without_changing_cosine_class(self):
        flags = semantic.review_flags('increased response to lipopolysaccharide', 'decreased response to lipopolysaccharide')
        self.assertEqual(flags[2], 1)
        self.assertEqual(flags[4], 'direction_conflict')
        self.assertEqual(semantic.classify_cosine(.99), 'A')

    def test_paraphrase_and_negation_flags(self):
        self.assertEqual(semantic.review_flags('decreased response to lipopolysaccharide', 'defective lipopolysaccharide response')[2], 0)
        self.assertEqual(semantic.review_flags('hearing loss', 'no hearing loss')[3], 1)
        self.assertEqual(semantic.review_flags('hearing loss', 'hearing impairment', True)[4], 'truncation_review')

    def test_ids_normalize_only_whitespace(self):
        self.assertEqual(semantic.phenotype_text_id('hearing   loss'), semantic.phenotype_text_id('hearing loss'))
        self.assertNotEqual(semantic.phenotype_text_id('hearing loss'), semantic.phenotype_text_id('hearing impairment'))

    def test_duplicate_source_ncbi_ids_are_retained_for_same_mgi_marker(self):
        base = dict(human_gene='A', human_ncbi_gene_id='1', mgi_marker_id='MGI:1', mouse_gene='a', mouse_ncbi_gene_id='2')
        rows = semantic.collapse_duplicate_orthologs([base, dict(base, mouse_ncbi_gene_id='3')])
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['mouse_ncbi_gene_id'], '2|3')
        with self.assertRaises(RuntimeError):
            semantic.collapse_duplicate_orthologs([base, dict(base, mgi_marker_id='MGI:2')])

    def test_normalized_variant_view_preserves_gene_and_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            connection = semantic.initialize_database(Path(directory) / 'fixture.sqlite')
            connection.execute("INSERT INTO ortholog VALUES ('A','1','ENSG1','HGNC:1','a','2','MGI:1','fixture')")
            connection.executemany('INSERT INTO phenotype_text VALUES (?,?,?)', [('h','human phenotype',0),('m','mouse phenotype',0)])
            hrow = ['HE:1','A','1','rs1','ClinVar','VCV1','h','HP:1','clinvar_condition','',0,1]
            mrow = ['ME:1','a','MGI:2','MGI:3','background','m','MP:1','MGI','PMID:1','a<allele>',1]
            hrow += [''] * (len(semantic.HUMAN_COLUMNS) - len(hrow))
            mrow += [''] * (len(semantic.MOUSE_COLUMNS) - len(mrow))
            connection.execute('INSERT INTO human_annotation VALUES (' + ','.join('?' for _ in hrow) + ')', hrow)
            connection.execute('INSERT INTO mouse_annotation VALUES (' + ','.join('?' for _ in mrow) + ')', mrow)
            record = dict(zip(semantic.DB_PAIR_COLUMNS, ['SM:1','A','a','h','m',.9,'A',1,1,'unspecified','unspecified',0,0,'unreviewed',0,0,1]))
            connection.execute('INSERT INTO phenotype_match VALUES (' + ','.join('?' for _ in record) + ')', list(record.values()))
            semantic.finalize_database(connection)
            row = connection.execute('SELECT rs_id,mgi_allele_id,curated_input FROM variant_correspondence').fetchone()
            self.assertEqual(row, ('rs1','MGI:2',0))
            # A phenotype annotation on a different gene must not join, even with identical text.
            hrow[0], hrow[1] = 'HE:2', 'OTHER'
            connection.execute('INSERT INTO human_annotation VALUES (' + ','.join('?' for _ in hrow) + ')', hrow)
            self.assertEqual(connection.execute('SELECT count(*) FROM variant_correspondence').fetchone()[0], 1)
            record.update(match_id='SM:D',cosine_similarity=.4,cosine_class='D',eligible_for_default_use=0)
            connection.execute('INSERT INTO phenotype_match VALUES (' + ','.join('?' for _ in record) + ')', list(record.values()))
            self.assertEqual(connection.execute('SELECT count(*) FROM variant_correspondence').fetchone()[0], 2)
            self.assertEqual(connection.execute('SELECT count(*) FROM active_variant_correspondence').fetchone()[0], 1)
            self.assertEqual(connection.execute("SELECT count(*) FROM active_phenotype_pairs WHERE cosine_class='D'").fetchone()[0], 0)
            connection.close()


if __name__ == '__main__':
    unittest.main()
