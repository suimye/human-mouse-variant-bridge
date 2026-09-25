# Ortholog-first semantic correspondence

この追加解析は、表現型の**文章の類似度**で対応候補を拾います。既存Tier 1/2/3とは別の分類です。Tier 2の`within_tier_support`は現在B/Cのみで、手動文献表現型に依存した旧Aは廃止しました。ここでの`cosine_class A/B/C/D`はTier 2のsupportとは別物です。生物学的な同等性や信頼度の確率を表しません。

## 比較の順序

1. `gene_gene_ortholog.tsv`のヒト遺伝子とマウス遺伝子の1:1対応を先に確定します。
2. 各遺伝子に紐づくヒトvariant evidenceとマウスallele/genotype evidenceを集めます。
3. 同じ遺伝子内で同じ表現型文は1種類にまとめ、文章だけをSapBERTで数値化します。遺伝子名やvariant名は入力文に足しません。
4. オーソログの遺伝子同士に属する表現型文だけを比較します。各文のベクトルを長さ1に揃え、その内積を`cosine_similarity`として保存します。
5. 表現型文の対応を、元のvariant/allele evidenceへDB上で結合します。ゲノム位置や変異残基の一致は要求しません。

| cosine_class | 条件 | 保存範囲 |
| --- | --- | --- |
| A | `0.8 <= cosine <= 1` | オーソログ内で条件を満たす全表現型文ペア |
| B | `0.7 <= cosine < 0.8` | オーソログ内で条件を満たす全表現型文ペア |
| C | `0.5 <= cosine < 0.7` | 各ヒト表現型文について、対応マウス遺伝子内の上位20件に含まれるものだけ。通常利用候補 |
| D | `-1 <= cosine < 0.5` | 同じ上位20件の保存範囲。保存専用で通常利用から除外 |

ちょうど0.5はC、0.7はB、0.8と1はAに含め、境界で未分類になる値をなくしています。これはコサイン**距離**ではなく**類似度**で、大きいほど文章が近くなります。距離で表すなら`1 - cosine`です。

C/Dとも全低類似度ペアや全variant組合せはファイル化しません。旧Cの候補を0.5でC/Dに分ける変更であり、検索範囲は変わりません。A/Bは上位20件の制限を受けません。

## 成果物と行の単位

成果物は`../output/semantic/`にあります。

| ファイル | 1行の単位 |
| --- | --- |
| `gene_gene_ortholog.tsv` | stable human gene IDとMGI markerに基づく遺伝子ペア |
| `phenotype_pairs_class_A.tsv.gz` | gene pair + human phenotype text + mouse phenotype text |
| `phenotype_pairs_class_B.tsv.gz` | 同上 |
| `phenotype_pairs_class_C.tsv.gz` | 同上。上位20件内の低類似度候補のみ |
| `phenotype_pairs_class_D.tsv.gz` | 同上。0.5未満、保存専用、通常利用から除外 |
| `human_annotations.tsv.gz` | 元のhuman variant-phenotype evidence 1行 |
| `mouse_annotations.tsv.gz` | 元のmouse allele/genotype-phenotype evidence 1行 |
| `phenotype_texts.tsv.gz` | 重複除去した文章。audit専用文はマッチング候補に混ぜない |
| `correspondence.sqlite` | 上記を関係別の表に分け、索引・VIEWを付けたDB |
| `class_catalog.tsv` | classの定義と正確な表現型文ペア件数 |
| `controls_summary.tsv` | 既知対照のA/B/C候補件数、D保存件数、A/B/C内の最大類似度 |
| `control_variant_pairs.tsv.gz` | 対照の全保存候補をvariant/allele evidenceへ展開。D行は利用対象外フラグ付き |
| `case_study_summary.tsv` | TLR4・CFTR・ALPLの全接続経路を横断した対象ペア回収サマリー |
| `phrase_audit.tsv` | 言い換え、逆方向、別臓器、否定の例示監査 |
| `summary.json` | 入力・モデル・出力SHA-256、設定、件数、実行環境、検証範囲 |

`human_annotations`はGRCh38座標、REF/ALT、ClinVar classification、GWAS P値、文献IDなどを保持します。`mouse_annotations`はallele/genotype ID、背景、MP ID、出典を保持します。`source_row`は入力TSVのヘッダーを除いた行番号です。`HE:`/`ME:` IDはその入力の行番号に基づき、入力ファイルのSHA-256と組にして追跡してください。文章IDは、文頭・文末の空白を除き、連続する空白を1個にした文章のSHA-256から作ります。複合表現型ラベルは分解せず、そのまま入力します。

SQLiteの主な表は`ortholog`、`phenotype_text`、`human_annotation`、`mouse_annotation`、`phenotype_match`、`metadata`です。`phenotype_pairs`と`variant_correspondence`はDも含む保存用VIEWです。**通常利用は`active_phenotype_pairs`と`active_variant_correspondence`**を使います。これらは`eligible_for_default_use=1`のA/B/Cだけを返します。Dはフラグ0で残し、分析対象から除外します。対照表の最大類似度、手動入力件数、方向衝突件数もA/B/C内で集計します。利用対象であっても生物学的同等性を保証するものではありません。全variant結合を実体表に展開すると大きくなるので、遺伝子・variant・classを限定してください。

```sql
-- 特定variantの対応を、出典とともに取得する。
SELECT v.*, h.label AS human_phenotype, m.label AS mouse_phenotype
FROM active_variant_correspondence v
JOIN phenotype_text h ON h.text_id = v.human_text_id
JOIN phenotype_text m ON m.text_id = v.mouse_text_id
WHERE v.human_gene = 'TLR4' AND v.rs_id = 'rs4986790'
ORDER BY v.cosine_similarity DESC;

-- 未レビューclass Aの文章ペアを表示する。「確認済み」ではない。
SELECT * FROM active_phenotype_pairs
WHERE cosine_class = 'A' AND review_status = 'unreviewed'
ORDER BY cosine_similarity DESC LIMIT 100;

-- 逆方向に見える文章を監査する。
SELECT * FROM active_phenotype_pairs WHERE direction_conflict = 1 LIMIT 100;

-- 手動human文献入力が存在しないことを確認する（結果は0行）。
SELECT * FROM active_variant_correspondence
WHERE human_gene = 'TLR4' AND rs_id = 'rs4986790' AND curated_input = 0;

-- 保存専用Dを調べる場合だけ、保存用VIEWから明示的に取得する。
SELECT * FROM phenotype_pairs WHERE cosine_class = 'D' LIMIT 100;
```

## 類似度の限界と改善案

SapBERTはUMLSの医学用語・同義表現の整列を学習したモデルで、human-mouse variantの機能的同等性を学習・検証したモデルではありません。採用した標準モデルでは、論文実装に沿ってpooler前のCLSを使います。文章の意味全体、否定、増加/減少の方向、臓器、刺激、背景、疾患と量的形質の区別を完全に解釈するわけではありません。

`direction_conflict`は明示的な増加語と低下/障害語の逆方向、`negation_flag`はno/not/without、`embedding_truncated`はトークン上限超過の補助フラグです。`review_status`はその注意理由を表します。単純な英語語彙規則なので、文中のどの対象に修飾が掛かるか、hypo/hyper接頭辞、正常/異常、複合疾患などは十分に扱えません。**フラグなしは同等性確認済みの意味ではありません。**raw cosine classはフラグで書き換えていません。

よりよい最終判定には、既存Tier 1のontology対応、Tier 3の疾患ID対応、uPheno的な対象/性質/方向の構造情報を併用する方法が考えられます。cross-encoder再評価も候補ですが、このデータで優れるという検証はまだありません。今回のA/B閾値も暫定値であり、独立した正例・逆方向・近いが別の表現型・無関係例を使ってprecision/recallを測るまではconfidence tierとして扱わないでください。

手動のヒト文献表現型は入力しません。TLR4専用に作ったLPS応答文と設定概念も廃止しました。TLR4 rs4986790は、ダウンロード済みGWAS Catalogの表現型とMGI表現型のcosine class C候補だけを保持します。`human_annotation`の`literature_curated`および`variant_source=Literature`は0行であることを検証します。TLR4のclass Cは既知対照の機序を再現した証拠ではなく、独立した較正セットでもありません。

入力は2026-09-11に取得し、解析用の列へ変換したデータです。今回あらためて配布元から取得し直したわけではありません。バージョンは`../DATA_VERSIONS.md`と`summary.json`を確認してください。同じhuman stable IDとMGI markerに対してmouse NCBI IDが複数ある入力行は、全IDを`|`区切りで保持して1遺伝子ペアにまとめます。別MGI markerへの曖昧な対応は自動的に選びません。

## 再実行

`2026/`を作業ディレクトリにして、Python 3.12で次を実行します。

```bash
python3 -m venv .venv-semantic
.venv-semantic/bin/python -m pip install -r requirements-semantic.txt
npm run download:semantic-model
npm run test:semantic
npm run map:semantic
npm run verify:semantic
npm run report:cases
```

モデル取得だけネットワークが必要です。使用したrevisionとSHA-256は`data/models/sapbert/manifest.json`に記録します。再実行時にはその値を検証し、同じモデルファイルであることを確認して再利用します。埋め込みは`data/processed/semantic_embeddings.npy`と`.json`に保存され、文章・モデル・pooling・トークン長の一致とSHA-256を確認して再利用します。元のNode解析はPythonを必要とせず、`npm run all`にはこの追加処理を含めていません。

## Primary references

- [SapBERT論文](https://aclanthology.org/2021.naacl-main.334/)
- [SapBERT公式実装・モデルの使い方](https://github.com/cambridgeltl/sapbert)
- [uPheno data integration / Entity-Quality](https://obophenotype.github.io/upheno/reference/data-integration/)
- [Sentence Transformers: retrieve and rerank](https://www.sbert.net/examples/sentence_transformer/applications/retrieve_rerank/README.html)
