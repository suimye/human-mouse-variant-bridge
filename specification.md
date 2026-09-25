# 2025仕様への2026実装対応

| 2025仕様 | 2026実装 |
| --- | --- |
| Human variant → HPO | ClinVar condition IDとHPO disease IDの一致で生成 |
| HPO–MP mappingとevidence | Monarch/UPhenoとMHMI SSSOMを統合し、predicate、confidence、justification、date、sourceを保存 |
| MP → mouse allele | MGI_GenePhenoを一遺伝子型へ限定して整形 |
| human–mouse ortholog | MGI HOM_ProteinCodingの1:1対応を必須化 |
| Node.js | Node.js標準ライブラリだけで取得、gzip、整形、結合、検証、SVG作成 |
| 工程ごとのサブルーチン | `download.js`、`prepare.js`、`map.js`、`validate.js`と共通ライブラリへ分離 |
| コメントは英語 | ソースコードのコメントを英語で統一 |
| 最新データ | URL、server更新日、取得日、SHA-256を自動記録 |
| 結果テーブル | gzip圧縮TSVと陽性・陰性対照TSVを生成 |
| 統計figure | `output/summary.svg`を生成 |
| TLR4 positive control | ClinVar、MGI ortholog、MGI allele/background、一次文献を独立検証 |
| HPO-MPの取りこぼし | 1:1 orthologを先に限定し、ClinVar/GWASとMGI MP/allele名を照合するTier 2と、表現型文のsemantic候補を追加。個別論文由来のhuman phenotypeは入力しない |
| DB化 | direct variant correspondenceのTier 0、phenotype/diseaseのTier 1/2/3、semantic classを分離し、同じvariant pairに複数のevidence routeを保持できる形で保存 |

## 実装上の判断

表現型を先に全マウスアレルへ展開すると巨大なspecies間直積が生じます。2026版はまずhuman geneの1:1 mouse orthologを確定し、そのmouse gene内でMPを照合します。これは候補を不当に減らすフィルターではなく、非オーソログ遺伝子間の誤対応を作らずに同じ論理結合を効率良く行うための順序です。

TLR4対照はHPO-MPに無い対応を人為的に追加しません。PDFおよび一次文献は対照ペアのidentityと生物学的背景の確認にだけ使い、human phenotype入力には加えません。現行データではTLR4はTier 1/2/3で未回収ですが、ダウンロード済みGWASとMGI表現型によるsemantic class C候補として対象ペアを保持します。この候補はLPS応答機序の一致を示すものではありません。

主要な評価単位は総行数ではなく、既知のhuman variant-mouse allele pairを、接続根拠と出典を失わずに検索できるかです。TLR4、CFTR、ALPLの3例では、単一経路の優劣ではなく、異なる経路を併用することで対象ペアを3/3回収できることを検証します。これは独立した精度ベンチマークではなく、対象ペア回収と経路相補性のcase studyです。

## Tier設計

0. Tier 0: 共同研究者が作成するdirect human–mouse variant correspondence。phenotype一致とは独立に保存し、`genomic_reciprocal_exact`、`coding_exact`、`protein_exact`のいずれの意味で完全一致か、assembly/transcript/alignment版、strand、reciprocal mapping、source hashを必須とする。実データ未受領のため現行件数には含めない。
1. Tier 1: Monarch/UPheno・MHMIのHPO-MP phenotype bridge。2025仕様の厳密経路。
2. Tier 2: MGI 1:1 orthologを確定後、human variant phenotype evidenceとmouse allele phenotype evidenceを比較。GWASはP <= 5e-8かつdirect SNP_GENE_IDSに限定。
3. Tier 3: 同じortholog gene内で、ClinVar conditionとMGI curated disease modelのOMIM IDが完全一致するもの。
4. Semantic class: 同じ1:1 ortholog gene内の表現型文をSapBERTで比較し、A/B/Cを通常利用候補、Dを保存専用とする。cosine classは生物学的同等性や確率を表さない。

Tier番号は接続戦略を表す。Tier 0は直接対応であり、Tier 1–3の順位付けではない。Tier 3のcurated disease modelがTier 2のlexical candidateより弱いという意味でもない。Tier 2内部はBを「小文字化・記号除去・定義済み別名置換後の表現型名全文一致」、Cをcontrolled lexical candidateとして保存し、手動概念に依存した旧support Aは廃止する。Semantic class A/B/C/DはTier 2 supportとは別分類である。Tier 0の受け入れ仕様は`database/TIER0_INTEGRATION.md`と`config/tier0-exact-variant.schema.json`で定義する。
