# Gemini 画像・動画生成

GenU から Google の Gemini API を呼び出して、画像生成・編集 (Nano Banana ファミリー) と動画生成・編集 (Gemini Omni Flash) を行う機能です。

- 画像: Vertex AI (`aiplatform.googleapis.com`) の `generateContent`
- 動画: Gemini API (`generativelanguage.googleapis.com`) の `interactions` エンドポイント

認証は **Workload Identity Federation (WIF)** を使います。**API キーは使いません**。Lambda の実行ロール (AWS 認証情報) を Google のアクセストークンに交換し、指定したサービスアカウントの権限で Google API を呼び出します。

```
フロントエンド ──(IAM 直接 Invoke)──▶ invokeGemini Lambda
    Lambda 実行ロールの AWS 認証情報
        │ ① SigV4 署名付き GetCallerIdentity を作成
        ▼
    Google STS (sts.googleapis.com) ── トークン交換
        │ ② federated token
        ▼
    iamcredentials.googleapis.com ── サービスアカウント借用 (generateAccessToken)
        │ ③ access token (scope: cloud-platform + generative-language.retriever)
        ▼
    aiplatform.googleapis.com (画像) / generativelanguage.googleapis.com (動画)
```

生成結果は既存の `fileBucket` (S3) に保存され、チャット履歴 (`/gemini-image`, `/gemini-video`) として自動記録されます。

## 必要な設定値

Google 側のセットアップ (後述) が完了すると、以下の 3 つの値が決まります。**`geminiWifAudience` / `geminiServiceAccountEmail` / `geminiProjectId` の 3 つすべてを `packages/cdk/cdk.json` に設定した場合のみ、デプロイ時に `InvokeGemini` Lambda が作成され、機能が有効になります**。未設定 (空文字) の間は Lambda 自体が作成されず、メニューにも表示されません。

```json
{
  "context": {
    "geminiWifAudience": "//iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/genu-aws-pool/providers/genu-aws-provider",
    "geminiServiceAccountEmail": "genu-gemini@<PROJECT_ID>.iam.gserviceaccount.com",
    "geminiProjectId": "<PROJECT_ID>",
    "geminiImageModel": "gemini-3.1-flash-image",
    "geminiImageLocation": "global",
    "geminiVideoModel": "gemini-omni-flash-preview"
  }
}
```

| パラメータ                  | 説明                                                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `geminiWifAudience`         | WIF プロバイダの完全リソース名 (`//iam.googleapis.com/...`)。**プロジェクト番号** (数字) を使う点に注意                                               |
| `geminiServiceAccountEmail` | 借用するサービスアカウントのメールアドレス                                                                                                            |
| `geminiProjectId`           | Google Cloud プロジェクト ID                                                                                                                          |
| `geminiImageModel`          | 画像モデル。`gemini-3.1-flash-image` (Nano Banana 2 / 〜4K)、`gemini-3.1-flash-lite-image` (Lite / 1K のみ)、`gemini-3-pro-image` (Pro / 1K〜4K) など |
| `geminiImageLocation`       | 画像モデルのロケーション。既定 `global`                                                                                                               |
| `geminiVideoModel`          | 動画モデル。既定 `gemini-omni-flash-preview` (執筆時点でプレビュー)                                                                                   |

## Google Cloud 側のセットアップ手順

以下は gcloud CLI での手順です (Cloud Shell で実行可)。Console での操作は各手順の補足を参照してください。

事前に決めておく値:

- `PROJECT_ID`: 対象の Google Cloud プロジェクト ID
- `AWS_ACCOUNT_ID`: GenU をデプロイしている AWS アカウント ID (12 桁)

また、この手順では以下のリソース名を例として使用します。任意の名前に変更可能です (変更した場合は、以降のコマンドと `geminiWifAudience` / `geminiServiceAccountEmail` の値を読み替えてください)。

- Workload Identity プール名: `genu-aws-pool`
- WIF プロバイダ名: `genu-aws-provider`
- サービスアカウント名: `genu-gemini`

```bash
export PROJECT_ID="<PROJECT_ID>"
export AWS_ACCOUNT_ID="<AWS_ACCOUNT_ID>"
gcloud config set project "${PROJECT_ID}"
```

### 1. API の有効化

```bash
gcloud services enable \
  aiplatform.googleapis.com \
  generativelanguage.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

- `aiplatform.googleapis.com`: 画像生成 (Vertex AI)
- `generativelanguage.googleapis.com`: 動画生成 (Gemini API)
- `iamcredentials.googleapis.com` / `sts.googleapis.com`: WIF のトークン交換・サービスアカウント借用に必要

> Console の場合: 「API とサービス」→「ライブラリ」で上記 4 つを検索して有効化。

### 2. Workload Identity プールと AWS プロバイダの作成

```bash
gcloud iam workload-identity-pools create genu-aws-pool \
  --location=global \
  --display-name="GenU AWS"

gcloud iam workload-identity-pools providers create-aws genu-aws-provider \
  --location=global \
  --workload-identity-pool=genu-aws-pool \
  --account-id="${AWS_ACCOUNT_ID}" \
  --attribute-mapping="google.subject=assertion.arn.extract('assumed-role/{role}/'),attribute.account=assertion.account,attribute.aws_role=assertion.arn.extract('assumed-role/{role}/')"
```

> **`--attribute-mapping` は必須です。** `create-aws` の既定は `google.subject = assertion.arn` ですが、CDK が生成するロール名 + Lambda 関数名 (セッション名) を含む assumed-role ARN は Google の `google.subject` 上限 127 バイトを超えるため、既定のままだとトークン交換が `The size of mapped attribute google.subject exceeds the 127 bytes limit` (400) で失敗します。上記のようにロール名のみを subject にマッピングしてください。認可は `attribute.account` (手順 4) で行うため、subject の変更は権限設定に影響しません。
>
> 既定マッピングで作成済みのプロバイダは、同じ `--attribute-mapping` を `gcloud iam workload-identity-pools providers update-aws genu-aws-provider --location=global --workload-identity-pool=genu-aws-pool --attribute-mapping=...` で更新すれば再デプロイ不要で直ります。

> Console の場合: 「IAM と管理」→「Workload Identity 連携」→「プールを作成」。プロバイダの種類は「AWS」を選び、AWS アカウント ID を入力。属性マッピングの `google.subject` を上記の値に変更。

### 3. サービスアカウントの作成とロール付与

```bash
gcloud iam service-accounts create genu-gemini \
  --display-name="GenU Gemini (image/video generation)"

# 画像生成 (Vertex AI generateContent) 用
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user"

# 動画生成 (generativelanguage を x-goog-user-project 付きで呼ぶ) 用
gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
  --member="serviceAccount:genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/serviceusage.serviceUsageConsumer"
```

> Console の場合: 「IAM と管理」→「サービス アカウント」→「サービス アカウントを作成」。ロールは「Vertex AI ユーザー」と「Service Usage ユーザー」を付与。

### 4. AWS からのサービスアカウント借用を許可

WIF プール経由で認証した AWS プリンシパルに、サービスアカウントの借用 (`roles/iam.workloadIdentityUser`) を許可します。

```bash
export PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding \
  "genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/genu-aws-pool/attribute.account/${AWS_ACCOUNT_ID}"
```

> 上記は「AWS アカウント内のすべての IAM ロール」に借用を許可します。invokeGemini Lambda の実行ロールだけに絞りたい場合は、デプロイ後に CloudFormation (スタックのリソース一覧) で `InvokeGemini` 関数の実行ロール名を確認し、member を `attribute.aws_role/<ロール名>` にした binding に置き換えてください (ロール名は再デプロイで変わることがある点に注意)。

### 5. cdk.json への設定値の反映

```bash
echo "geminiWifAudience: //iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/genu-aws-pool/providers/genu-aws-provider"
echo "geminiServiceAccountEmail: genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com"
echo "geminiProjectId: ${PROJECT_ID}"
```

出力された 3 つの値を `packages/cdk/cdk.json` の `context` に設定し、GenU をデプロイします。デプロイ後、メニューに「画像生成・編集 (Gemini)」「動画生成・編集 (Gemini)」が表示されます。

## 機能・制約

- **画像**: テキストから生成、画像 + テキストで編集 (最大 4 枚 / 合計 4MB)。アスペクト比、解像度 (512 / 1K / 2K / 4K。モデル非対応の解像度は自動調整)、生成枚数 (1〜4) を指定可能
- **動画**: テキスト / 参照画像から生成 (16:9 / 9:16、音声付き MP4)。編集は 2 方式:
  - 直前の生成結果の**ステートフル編集** (interaction ID を使用。動画の再アップロード不要)
  - 手持ち動画 (MP4 / WebM、最大 4MB) のアップロード編集
- 入力の合計 4MB 制限は Lambda 直接 Invoke のペイロード上限 (6MB、base64 で約 4/3 に膨張) によるものです。生成結果を編集素材に再利用する場合は S3 URL で渡すためこの制限を消費しません
- 動画生成は数分かかることがあります (Lambda タイムアウト 15 分)
- EEA (欧州経済領域)・スイス・英国では、アップロードした動画の編集は Gemini API 側で非対応です (生成結果のステートフル編集は可能)
- `gemini-omni-flash-preview` は執筆時点でプレビュー版のため、API 仕様が変更される可能性があります

## トラブルシューティング

| 症状                                         | 原因・対処                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Google STS token exchange failed (400)`     | `geminiWifAudience` の形式誤り (プロジェクト **ID** ではなく**番号**を使う)、またはプール / プロバイダ名の不一致              |
| `Service account impersonation failed (403)` | 手順 4 の `roles/iam.workloadIdentityUser` binding 漏れ、または member の指定誤り                                             |
| `403 PERMISSION_DENIED` (画像)               | `aiplatform.googleapis.com` 未有効化、またはサービスアカウントに `roles/aiplatform.user` が無い                               |
| `403 PERMISSION_DENIED` (動画)               | `generativelanguage.googleapis.com` 未有効化、または `roles/serviceusage.serviceUsageConsumer` が無い                         |
| `429`                                        | レート制限。時間を置いて再試行                                                                                                |
| メニューに表示されない                       | `geminiWifAudience` / `geminiServiceAccountEmail` / `geminiProjectId` の 3 つすべてが設定された状態でデプロイされているか確認 |
