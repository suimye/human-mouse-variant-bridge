# TogoVar-MoG+ human-mouse variant correspondence (2026 rebuild)

2025年版の仕様を基に、最新データの取得、整形、3つの独立した対応戦略、対照検証、統計図までをNode.jsで再実装したものです。2025年版のサンプルTSVは解析入力に使っていません。

## 共同研究者向けの入口

このリポジトリは、ヒトvariantとマウスalleleの候補対応を、単一の「正解」ではなく、**どの情報で接続されたか**とともに扱うための再現可能なパイプラインです。まずは次の資料を参照してください。

| 確認したいこと | 資料 |
| --- | --- |
| 解析の要約、再実行方法、成果物への入口 | このREADME |
| Tier 1/2/3が何を根拠に接続するか | [`output/tier_evidence_explainer.html`](output/tier_evidence_explainer.html) |
| TLR4・CFTR・ALPLで接続手法がどう補い合うか | [`output/case_study_evidence_explainer.html`](output/case_study_evidence_explainer.html) |
| 入力データ、6段階の生成手順、SapBERT、DB保存形式、3症例の生物学的背景 | [`output/methods_and_biological_evidence.html`](output/methods_and_biological_evidence.html) ([English](output/methods_and_biological_evidence_en.html)) |
| データセットの取得記録と完全性確認値 | [`DATA_VERSIONS.md`](DATA_VERSIONS.md) と [`data/raw/manifest.json`](data/raw/manifest.json) |
| 機械可読な3症例の結果 | [`output/semantic/case_study_summary.tsv`](output/semantic/case_study_summary.tsv) |
| Tier 0（完全一致データ）の受入れ・検証・統合方法 | [`database/TIER0_INTEGRATION.md`](database/TIER0_INTEGRATION.md) |

通常の再構築は[`run.sh`](run.sh)が入口です。ダウンロード済みのデータや大容量の生成物はGitに含めず、配布元から再取得して作成します。

## このデータで示すこと

主要な評価対象は、総リンク数ではなく、**表現型連携によって研究で検討できるhuman-mouse variant pairを取得できるか**です。1:1 orthologを共通の足場にして、HPO-MP ontology、表現型名、共通疾患ID、表現型文のsemantic similarityを別々の接続根拠として保存します。単一の方法へ統一せず、同じvariant pairに複数のevidence rowを持たせる設計です。

TLR4、CFTR、ALPLをcase studyにすると、指定した3組は接続方法が異なるものの、経路を統合した検索では3/3組を回収しました。これは独立した精度ベンチマークではなく、既知例を使って**異なる接続手法から対象ペアを回収できるか確認した結果**です。

| case study | human-mouse target pair | 主な回収経路 | 結果の意味 |
| --- | --- | --- | --- |
| TLR4 | rs4986790 - Tlr4<Lps-d> | ortholog + semantic class C | 厳密な3 Tierで落ちた対象ペアを、炎症性表現型の緩い候補として回収。LPS機序の一致を示すものではない |
| CFTR | rs113993960 p.Phe508del - Cftr<tm1Unc> | HPO-MP + OMIM:219700 disease model | 構造化表現型と疾患モデルの独立した根拠で回収 |
| ALPL | rs1558543066 - Alpl<Hpp> | hypophosphatasia完全一致 + OMIM:146300 disease model | HPO-MPで指定アレルを回収できなくても、表現型名と疾患モデルで回収 |

Tier 1/2/3の接続原理は[`output/tier_evidence_explainer.html`](output/tier_evidence_explainer.html)に残し、3例で異なる接続手法が必要になる理由は[`output/case_study_evidence_explainer.html`](output/case_study_evidence_explainer.html)に分けました。生物学的根拠、構造的なvariant差、利用したデータセット、構築手順、DB設計を統合したMethodsは[`output/methods_and_biological_evidence.html`](output/methods_and_biological_evidence.html)です。機械可読な比較は[`output/semantic/case_study_summary.tsv`](output/semantic/case_study_summary.tsv)です。

英語版は[`METHODS_AND_CASE_STUDIES_EN.md`](METHODS_AND_CASE_STUDIES_EN.md)と[`output/methods_and_biological_evidence_en.html`](output/methods_and_biological_evidence_en.html)です。

公開時の推奨リポジトリ名、含めるファイル、除外する大容量・再配布要確認データは[`PUBLISHING.md`](PUBLISHING.md)にまとめました。

## Tier 0（共同研究者データの統合口）

共同研究者が作成したhuman variant–mouse variant完全一致データは、phenotypeとは独立した**Tier 0 direct correspondence**として同じpair/evidenceモデルへ統合します。ただし「完全一致」の意味を曖昧にしないため、`genomic_reciprocal_exact`、`coding_exact`、`protein_exact`を`match_level`で区別し、assembly、versioned transcript/alignment、strand、reciprocal mapping、元ファイルSHA-256を各行に保持します。

受け入れ仕様は[`database/TIER0_INTEGRATION.md`](database/TIER0_INTEGRATION.md)、交換用headerは[`data/external/tier0_exact_variant.template.tsv`](data/external/tier0_exact_variant.template.tsv)、機械可読schemaは[`config/tier0-exact-variant.schema.json`](config/tier0-exact-variant.schema.json)です。実データはまだこのworkspaceにないため、現在のTier件数、`tier_catalog.tsv`、3例の回収結果にはTier 0を混ぜていません。

テンプレートと同じ列に揃えたファイルは`npm run validate:tier0 -- path/to/collaborator.prepared.tsv`で、列順、必須provenance、match-level別の必要項目、SHA-256形式、reciprocal mapping、既存1:1 orthologとの一致を検査できます。

## Tier別の実行結果

| Tier | 接続根拠 | 結果行数 | 主な用途 |
| --- | --- | ---: | --- |
| Tier 1 | ClinVar condition -> HPO -> Monarch/UPhenoまたはMHMI HPO-MP -> MGI allele + 1:1 ortholog | 1,089,740 | ontologyに基づく厳密な表現型ブリッジ |
| Tier 2 | 1:1 orthologを先に限定し、ClinVar/GWASとMGI MP/allele名の表現型証拠を照合 | 76,619 | HPO-MPで落ちる候補の回収。手動文献表現型は使わない |
| Tier 3 | ClinVarとMGI curated disease modelの同一OMIM ID + 1:1 ortholog | 331,245 | ontology bridgeと独立した疾患モデル対応 |

Tier番号は異なる検索戦略を表し、普遍的な信頼度順位ではありません。Tier 2だけは内部に次の`within_tier_support`を持ちます。

- `B`: 小文字化・記号除去・定義済み別名置換後に、表現型名全体が一致
- `C`: informative tokenによる語彙的一致。仮説候補であり手動確認が必要

旧support Aは、個別の文献表現型と手動設定概念に依存するため廃止しました。Tier 2の内訳はA 0行、B 9,512行、C 67,107行です。

## DB用成果物

### 追加: ortholog-first文章類似度

表現型文を医学用語向けSapBERTで数値化し、1:1オーソログ内のコサイン類似度で別リストを作りました。`output/semantic/`にclass A（0.8以上）、B（0.7以上0.8未満）、C（0.5以上0.7未満）、D（0.5未満・保存専用）の文章ペア、variant evidence表、結合用SQLite DBを保存します。C/Dは既存の上位20候補内という範囲を維持します。Dは`eligible_for_default_use=0`で残し、通常利用用の`active_phenotype_pairs` / `active_variant_correspondence`から除外します。既存Tier 2のsupport A/B/Cとは別分類です。

類似度だけで生物学的同等性は確定できません。逆方向・否定の補助フラグと、TLR4等の既知対照・例示的negative phrase監査も保存します。手動のヒト文献表現型はsemantic入力にもTier 2入力にも加えません。詳細・DB結合例・再実行方法は[semantic解析の説明](database/SEMANTIC.md)、結果と限界は[解析結果](output/semantic/RESULTS.md)を参照してください。今回の入力は2026-09-11取得データです。

| ファイル | 内容 |
| --- | --- |
| `run.sh` | 取得、変換、Tier/Semantic作成、検証を決めた順番で実行する入口 |
| `config/workflow.json` | 配布元URL、保存先、採用条件、Semantic閾値、Tier定義をまとめた唯一の実行設定 |
| `data/external/tier0_exact_variant.template.tsv` | 共同研究者のTier 0を受け取るための列定義（データ本体は未受領） |
| `config/tier0-exact-variant.schema.json` | Tier 0行の必須項目と許容値 |
| `database/TIER0_INTEGRATION.md` | exact matchの定義、QC、既存pair/evidenceへの統合手順 |
| `output/tier1_monarch_phenotype.tsv.gz` | Tier 1本体 |
| `output/tier2_ortholog_phenotype.tsv.gz` | Tier 2本体 |
| `output/tier3_disease_model.tsv.gz` | Tier 3本体 |
| `output/tier_catalog.tsv` | Tier定義と正確な行数 |
| `output/tier_validation_results.tsv` | positive control x Tierの検証行列 |
| `output/tier_summary.svg` | Tier件数と対照回収の編集可能な図 |
| `output/tier_evidence_explainer.html` | ゲノム領域、ortholog gene、matching point、Tier 1/2/3の接続根拠を示す模式図 |
| `output/case_study_evidence_explainer.html` | TLR4・CFTR・ALPLで異なる接続手法が必要になる理由を示す模式図と比較表 |
| `output/methods_and_biological_evidence.html` | 生物学的根拠、利用したデータセット、構築法、DB設計、3例を統合したMethodsページ |
| `output/methods_and_biological_evidence_en.html` | 上記Methodsページの英語版 |
| `output/methods_data_linkage.svg` | human/mouse genomeからDBまでの連携手順を示す編集可能な図 |
| `output/tier_matching_strategy_ja.svg` | 1:1 ortholog gene内でTier 1/2/3がhuman variantとmouse alleleを結ぶ日本語模式図 |
| `output/tier_matching_strategy_en.svg` | 上記Tier模式図の英語版 |
| `output/data_generation_workflow_ja.svg` | Step 2–4の並行処理とStep 5への合流を示す日本語フローチャート |
| `output/data_generation_workflow_en.svg` | 上記フローチャートの英語版 |
| `METHODS_AND_CASE_STUDIES.md` | 上記Methodsの文書版 |
| `METHODS_AND_CASE_STUDIES_EN.md` | 上記Methods文書の英語版 |
| `output/semantic/case_study_summary.tsv` | TLR4・CFTR・ALPLの経路別回収数、代表証拠、解釈、限界 |
| `data/processed/ortholog_mapping_enriched.tsv` | NCBI/HGNC/Ensembl/MGIを持つ1:1 ortholog表 |
| `data/processed/human_variant_phenotypes.tsv.gz` | ClinVarとGWASのhuman variant evidence。手動文献行は含まない |
| `data/processed/mouse_variant_phenotypes.tsv.gz` | MGI MPとallele名のmouse evidence |
| `database/schema.sql` | SQLite向けの表・索引定義 |
| `DATA_VERSIONS.md` | URL、server更新日、取得日時、容量、SHA-256 |

各Tier TSVは先頭列に`tier_id`と`connection_basis`を持ち、1行ごとにhuman variant、mouse allele/genotype、接続根拠、出典を追跡できます。`database/README.md`にロード時の注意を記載しています。

## Case-study target pairs

| 対照 | Tier 1 | Tier 2 | Tier 3 | 解釈 |
| --- | ---: | ---: | ---: | --- |
| TLR4 rs4986790 - Tlr4<Lps-d> | 0 | 0 | 0 | Tier側では未回収。別のsemantic class C候補として保持 |
| CFTR rs113993960 p.Phe508del - Cftr<tm1Unc> | 6 | 0 | 2 | HPO-MP表現型とOMIM:219700疾患モデルの双方で回収 |
| ALPL rs1558543066 p.Val7fs - Alpl<Hpp> c.862+5G>A splice-site hypomorph | 0 | 20 (support B) | 2 | hypophosphatasia完全一致とOMIM:146300疾患モデルで回収 |

全9個の「対照 x Tier」期待値はPASSです。semantic候補まで含む経路統合では3/3の対象ペアを回収しました。非オーソログ接続と同一残基という過剰主張を防ぐnegative controlは2/2 PASSです。

### TLR4の扱い

PDFの対照はhuman TLR4 rs4986790/p.Asp299Glyとmouse Tlr4<Lps-d>/p.Pro712Hisです。両者は同じ残基のvariantではなく、別々のmissense variantがLPS応答低下を示す機能的対応です。

現行ClinVarでrs4986790のaggregate classificationは`Benign`で、疾患HPOからHPO-MPへ直接進むTier 1では0行です。個別論文から作ったヒトLPS応答文とTLR4専用概念は、全遺伝子へ一貫して適用できないため廃止しました。Tier 2でも0行です。

TLR4は、ダウンロード済みGWAS Catalogのrs4986790に付く慢性炎症性疾患の複合ラベルと、MGIの`increased susceptibility to induced arthritis`とのsemantic class C候補（cosine約0.548）として1 evidence行を保持します。これはLPS応答が同等だと示す一致ではなく、要レビューの緩い表現型候補です。旧手動行は再利用しない監査記録として`data/controls/human_variant_phenotypes.retired.tsv`へ退避しました。

## データと採用範囲

- ClinVar GRCh38 VCF: rsID、1:1 ortholog gene、設定済みclinical significanceを持つcondition evidence
- HPO: `NOT`でなくaspect `P`のdisease annotation
- Monarch/UPheno・MHMI: confidence 0.8以上、exact/close/broad/narrow match
- GWAS Catalog v1.0.2: `P <= 5e-8`、`SNP_GENE_IDS`のEnsembl geneがHGNC経由で1:1 orthologへ直接一致するassociation
- MGI: 一遺伝子の非conditional genotype、specific MP、phenotypic allele名、curated disease model
- Ortholog: MGI `HOM_ProteinCoding.rpt`の1:1 protein-coding ortholog
- Tier 3: human ClinVar conditionとmouse disease modelでOMIM IDが完全一致

データURL、保存ファイル名、採用条件、Semantic閾値、Tier定義、実行設定はすべて[`config/workflow.json`](config/workflow.json)にまとめています。配布元URLやファイル名が変わった場合は、このファイルの該当する`data_sources`行だけを修正します。解析スクリプト内のpathを直接書き換える必要はありません。配布ファイル自体の列構成や圧縮形式が変わった場合は、設定変更だけでは解釈できないため、該当する読み取り処理も改修してテストします。

## 実行方法

Node.js 20以上とPython 3.12用の`.venv-semantic`を使用します。GWAS ZIPの展開にはOSの`unzip`を使います。データ取得からTier 1–3、Semantic、検証、3症例サマリー、Tier 0入力検査までを次の1コマンドで順番に実行します。

```bash
cd 2026
./run.sh
```

実行せず工程とスクリプト名だけを確認する場合:

```bash
./run.sh --dry-run
```

既に取得したファイルを使う場合は`./run.sh --skip-download`、Semanticを実行しない場合は`./run.sh --skip-semantic`、全データを再取得する場合は`./run.sh --force-download`です。通常実行では、配布元のETag、Last-Modified、または配布版名が同じファイルを再利用します。

各工程を個別に調べるための従来の`npm run prepare`等も残していますが、再現用の正式な入口は`run.sh`です。

## 注意事項

- すべての結果は候補対応であり、humanとmouseのvariantが配列上同一、同一残基、または同一機序であることを意味しません。
- 同じortholog geneであることだけでは出力しません。Tier 2は表現型証拠、Tier 3は同一疾患IDを追加で要求します。
- GWASのgene assignmentは近傍遺伝子名だけでなく、Catalogの`SNP_GENE_IDS`に直接記載されたEnsembl geneに限定しています。
- Tier 2 support Cは探索用です。support Aは廃止済みで、DBの既定表示ではBを先にし、Cには要レビュー表示を推奨します。
- `skos:broadMatch`と`skos:narrowMatch`はexactより広い候補を含みます。
- HPOのOMIM由来annotationには再利用上の制限があり得ます。再配布前に利用条件を確認してください。

## 主な参考文献

- Arbour NC, et al. *Nat Genet.* 2000;25:187-191. PMID:10835634.
- Figueroa L, et al. *J Immunol.* 2012;188:4506-4515. PMID:22474023.
- Poltorak A, et al. *Science.* 1998;282:2085-2088. PMID:9851930.
- Qureshi ST, et al. *J Exp Med.* 1999;189:615-625. PMID:9989976.
- Snouwaert JN, et al. *Science.* 1992;257:1083-1088. PMID:1380723.
- Hough TA, et al. *J Bone Miner Res.* 2007;22:1397-1407. PMID:17539739.
- MGI Tlr4<Lps-d>: https://www.informatics.jax.org/allele/MGI:1857718
