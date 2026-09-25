# 表現型文のコサイン類似度による候補対応

2026-09-24再実行。入力は2026-09-11に各配布元から取得したファイルです。個別論文から作ったヒト表現型行を廃止し、ClinVarとGWAS Catalog由来のヒト証拠だけで再生成しました。使用した[SapBERT](https://aclanthology.org/2021.naacl-main.334/)のrevisionとSHA-256を記録しています。SapBERTはhuman-mouse variantの同等性を直接学習したモデルではありません。

## 研究上の評価軸

このデータ作成の主要な問いは、表現型連携から**実際に検討対象となるhuman-mouse variant pairを取得できるか**です。raw行数や最大cosineだけを成功指標にはしません。1:1 orthologを共通の足場とし、HPO-MP、表現型名、共通疾患ID、semantic similarityを独立した接続経路として保持します。

指定した3つのcase-study pairは、経路を統合すると3/3組を回収しました。ただし、これは選定済みの既知例による回収確認であり、独立した精度・再現率ベンチマークではありません。

| case-study pair | 構造化Tierでの主な回収 | semantic evidence | 実用上の位置づけ |
| --- | --- | --- | --- |
| TLR4 rs4986790 - Tlr4<Lps-d> | Tier 1/2/3はいずれも0 | class C 1行、cosine 0.548 | 厳密経路の取りこぼしを拾う要レビュー候補。LPS機序の一致は示さない |
| CFTR rs113993960 - Cftr<tm1Unc> | Tier 1が6行、Tier 3が2行 | A/B/C候補はあるが、最大Aは嚢胞性線維症の主根拠に使わない | HPO-MPとOMIM疾患モデルの独立した構造化根拠を優先 |
| ALPL rs1558543066 - Alpl<Hpp> | Tier 2 exact labelが20行、Tier 3が2行 | A 22行、最大cosine 1.000 | hypophosphatasiaの完全一致とOMIM疾患モデルが整合 |

機械可読な比較は[case_study_summary.tsv](case_study_summary.tsv)、3例の模式図と経路別比較は[case-study HTML](../case_study_evidence_explainer.html)に保存しました。Tier自体の接続原理は別の[Tier説明HTML](../tier_evidence_explainer.html)に残しています。同じpairに複数のevidence rowを持たせ、route、元source、score、review flagを失わずにDB検索できることが、この方式の中心的な意義です。

## 保存したリスト

16,536オーソログ遺伝子ペアを確定し、両種の証拠がある11,836ペアについて、文章の6,095,652組を比較しました。human evidenceは1,642,615行、mouse evidenceは306,369行です。手動ヒト文献行は0件です。重複除去した文章は52,535種類（例示監査用を含む）で、128トークンの上限超過はありません。

| class | コサイン類似度 | 表現型文ペア数 | ファイル |
| --- | --- | ---: | --- |
| A | 0.8以上 | 1,702 | [class A](phenotype_pairs_class_A.tsv.gz) |
| B | 0.7以上、0.8未満 | 4,412 | [class B](phenotype_pairs_class_B.tsv.gz) |
| C | 0.5以上、0.7未満 | 66,367 | [class C](phenotype_pairs_class_C.tsv.gz) |
| D | 0.5未満・保存専用 | 2,836,628 | [class D](phenotype_pairs_class_D.tsv.gz) |

A/Bはオーソログ内で閾値以上の全文章ペアです。C/Dは各human文から対応mouse gene内を検索した上位20件に含まれる低類似度ペアだけです。手動文献行の除外に伴い、以前その文から生じていた文章ペアも削除しました。上位20件外の3,186,543組は省いています。ちょうど0.5はCです。

通常利用対象はA/B/Cの72,481組です。Dは別ファイルとDBに`eligible_for_default_use=0`で残し、通常利用用の`active_phenotype_pairs`と`active_variant_correspondence`では除外します。Dを削除したり、候補の全組合せを新たに展開したりはしていません。

リストの行数は**variant対応数ではなく、遺伝子内の文章ペア数**です。[SQLite DB](correspondence.sqlite)の`active_variant_correspondence` VIEWからDを除いて元のvariant/allele/genotype evidenceを結合できます。Dを含む保存候補全体は`variant_correspondence`です。全variant evidence組合せ127,770,246組の事前展開を避けています。[DBの構造・使い方](../../database/SEMANTIC.md)を参照してください。

## 既知対照で見つかった候補

以下は指定rsIDとMGI allele IDを含む**evidence結合行数**です。複数のClinVar condition record、genotype、背景を含み、独立した実験数ではありません。候補が存在することと、対照の期待表現型を正しく拾うことを分けて評価します。

| 対照 | A | B | C | D保存のみ | A/B/C最大cosine | 解釈 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| TLR4 rs4986790 / MGI:1857718 | 0 | 0 | 1 | 78 | 0.548 | ダウンロード済みGWASとMGIの緩いclass C候補だけを保持 |
| CFTR rs113993960 / MGI:1856709 | 1 | 1 | 61 | 434 | 0.833 | Aは精子異常の別用語ペア。嚢胞性線維症の一致を確認した結果ではない |
| ALPL rs1558543066 / MGI:3051587 | 22 | 2 | 24 | 0 | 1.000 | hypophosphatasia同士とinfantile hypophosphatasiaの近接をAで回収 |

TLR4のclass C 1行は、GWAS Catalogの`ankylosing spondylitis, psoriasis, ulcerative colitis, Crohn disease, sclerosing cholangitis`と、MGIの`increased susceptibility to induced arthritis`の組合せです（cosine 0.548、GCST005537）。これは炎症性疾患・関節炎に関する緩い候補であり、LPS応答機序の一致を示しません。個別論文から抽出した`decreased response to lipopolysaccharide`は入力にも例示監査にも使っていません。

CFTRのAは`Obstructive azoospermia`と`asthenozoospermia`（0.833）でした。両者は別の精子異常の用語で、同一表現型と断定できません。`cystic fibrosis`からmouseの`pulmonary interstitial fibrosis`は0.592でC、`decreased respiratory epithelial chloride transmembrane transport`は0.496でD（保存のみ・利用対象外）です。この例では、疾患名と機能的・臓器表現型を結ぶ既存のontology/disease-model経路を文章類似度だけで置き換えられません。

数値と全対照候補は[controls_summary.tsv](controls_summary.tsv)、[control_variant_pairs.tsv.gz](control_variant_pairs.tsv.gz)にあります。

## 閾値だけで切ってよいか

**候補探索には使えますが、Aでも生物学的同等性の確定には使えません。**実データのAには以下の逆方向ペアもあり、`direction_conflict=1`を付けています。

| human文 | mouse文 | cosine | class |
| --- | --- | ---: | --- |
| Decreased circulating IgM concentration | increased IgM level | 0.812 | A |
| Reduced bone mineral density | increased bone mineral density | 0.805 | A |

Aでは2組、Bでは8組に明示的な方向衝突がありました。Bには否定語フラグも4組あります。raw classは変更せず、注意理由を併記します。単純な語彙規則なので、フラグのないA/Bが正しいという意味でもありません。

[phrase_audit.tsv](phrase_audit.tsv)では言い換え例は0.904〜0.976でA、増加/減少の逆方向例は0.711でB、`hearing loss`と`no hearing loss`も0.729でBでした。刺激対象が異なる文も0.723でBに入り、コサイン単独の限界を示します。TLR4専用文は例示監査からも除外しています。これは精度ベンチマークではありません。

推奨は**オーソログ限定 → cosine候補検索 → 対象・方向・否定の確認 → ontology/疾患IDの既存根拠との照合**です。[uPhenoのEntity-Quality方式](https://obophenotype.github.io/upheno/reference/data-integration/)などの構造情報が追加根拠になります。cross-encoder再評価も選択肢ですが、このデータでよりよいことは未検証です。0.8/0.7をconfidence tierの境界とするには、手動入力の既知対照とは独立した正例・難しい負例で較正する必要があります。

## 再現性と実装検証

モデル・入力・埋め込み・出力のSHA-256と設定は[summary.json](summary.json)にあります。[verification.json](verification.json)は計算・DB検査の記録です。全TSVの件数・数値境界、非オーソログ混入、C/Dのrank制限、利用対象フラグ、Dの通常利用VIEWへの混入、元evidence参照、SQLite整合性、全A/Bの保存漏れを検査します。1,000ペアのfloat64独立再計算も行います。これは計算とDBの正しさの検査で、生物学的精度の検証ではありません。

semantic単体テスト11件、Nodeテスト24件もPASSしました。MGI ortholog入力に同じhuman gene IDとMGI markerの重複が1件あり、mouse NCBI IDを両方保持して1ペアにまとめました。
