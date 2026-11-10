# 画像・動画生成 (Gemini / GPT Image) のデプロイ

GenU から外部の生成 AI API を呼び出して画像・動画を生成する機能のセットアップ手順です。どちらも既定では無効で、設定した場合のみリソースが作成され、メニューに表示されます。

- [Gemini 画像・動画生成](#gemini-画像動画生成): Google の Gemini API を使用 (Workload Identity Federation 認証、API キー不要)
- [GPT Image 画像生成・編集](#gpt-image-画像生成編集): OpenAI の Images API を使用 (API キー認証)

両方の画像生成ページに共通の機能として、[チャット履歴を参照した画像生成](#チャット履歴を参照した画像生成)と [PDF 一括保存](#pdf-一括保存)があります。

## Gemini 画像・動画生成

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

### 必要な設定値

Google 側のセットアップ (後述) が完了すると、以下の 3 つの値が決まります。これを `packages/cdk/cdk.json` に設定してデプロイすると機能が有効になります (未設定の間はメニューに表示されません)。

```json
{
  "context": {
    "geminiWifAudience": "//iam.googleapis.com/projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/genu-aws-pool/providers/genu-aws-provider",
    "geminiServiceAccountEmail": "genu-gemini@<PROJECT_ID>.iam.gserviceaccount.com",
    "geminiProjectId": "<PROJECT_ID>",
    "geminiImageModel": "gemini-nano-banana-2.1",
    "geminiImageModels": ["gemini-3-pro-image"],
    "geminiImageLocation": "global",
    "geminiVideoModel": "gemini-omni-1.2-flash",
    "geminiVideoModels": []
  }
}
```

| パラメータ                  | 説明                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `geminiWifAudience`         | WIF プロバイダの完全リソース名 (`//iam.googleapis.com/...`)。**プロジェクト番号** (数字) を使う点に注意                                                                                                            |
| `geminiServiceAccountEmail` | 借用するサービスアカウントのメールアドレス                                                                                                                                                                         |
| `geminiProjectId`           | Google Cloud プロジェクト ID                                                                                                                                                                                       |
| `geminiImageModel`          | 既定の画像モデル。既定 `gemini-nano-banana-2.1` (Nano Banana 2.1 / 1K〜4K)。ほかに `gemini-3-pro-image` (Nano Banana Pro / 1K〜4K)、`gemini-3.1-flash-image` (Nano Banana 2 / 512〜4K、Gemini API では非推奨) など |
| `geminiImageModels`         | 画像ページのモデル選択に追加で並べるモデル (既定 `[]`)。Lambda はここと `geminiImageModel` に挙げたモデルしか受け付けません                                                                                        |
| `geminiImageLocation`       | 画像モデルのロケーション。既定 `global`                                                                                                                                                                            |
| `geminiVideoModel`          | 既定の動画モデル。既定 `gemini-omni-1.2-flash`。`gemini-omni-flash-preview` は 2026-10-22 に提供終了                                                                                                               |
| `geminiVideoModels`         | 動画ページのモデル選択に追加で並べるモデル (既定 `[]`)                                                                                                                                                             |

### Google Cloud 側のセットアップ手順

以下は gcloud CLI での手順です (Cloud Shell で実行可)。Console での操作は各手順の補足を参照してください。

事前に決めておく値:

- `PROJECT_ID`: 対象の Google Cloud プロジェクト ID
- `AWS_ACCOUNT_ID`: GenU をデプロイしている AWS アカウント ID (12 桁)

```bash
export PROJECT_ID="<PROJECT_ID>"
export AWS_ACCOUNT_ID="123456789012"
gcloud config set project "${PROJECT_ID}"
```

#### 1. API の有効化

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

#### 2. Workload Identity プールと AWS プロバイダの作成

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

#### 3. サービスアカウントの作成とロール付与

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

#### 4. AWS からのサービスアカウント借用を許可

WIF プール経由で認証した AWS プリンシパルに、サービスアカウントの借用 (`roles/iam.workloadIdentityUser`) を許可します。

```bash
export PROJECT_NUMBER=$(gcloud projects describe "${PROJECT_ID}" --format='value(projectNumber)')

gcloud iam service-accounts add-iam-policy-binding \
  "genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/genu-aws-pool/attribute.account/${AWS_ACCOUNT_ID}"
```

> 上記は「AWS アカウント内のすべての IAM ロール」に借用を許可します。invokeGemini Lambda の実行ロールだけに絞りたい場合は、デプロイ後に CloudFormation (スタックのリソース一覧) で `InvokeGemini` 関数の実行ロール名を確認し、member を `attribute.aws_role/<ロール名>` にした binding に置き換えてください (ロール名は再デプロイで変わることがある点に注意)。

#### 5. cdk.json への設定値の反映

```bash
echo "geminiWifAudience: //iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/genu-aws-pool/providers/genu-aws-provider"
echo "geminiServiceAccountEmail: genu-gemini@${PROJECT_ID}.iam.gserviceaccount.com"
echo "geminiProjectId: ${PROJECT_ID}"
```

出力された 3 つの値を `packages/cdk/cdk.json` の `context` に設定し、GenU をデプロイします。デプロイ後、メニューに「画像生成・編集」「動画生成・編集」が表示されます (画像生成・編集は GPT Image と共通の画面です)。

### 機能・制約

- **画像**: テキストから生成、画像 + テキストで編集 (最大 4 枚 / 合計 4MB)。アスペクト比、解像度 (1K / 2K / 4K。512 は `gemini-3.1-flash-image` のみ。モデル非対応の解像度は自動調整)、生成枚数 (1〜4) を指定可能
- **動画**: テキスト / 参照画像から生成 (16:9 / 9:16、音声付き MP4)。編集は 2 方式:
  - 直前の生成結果の**ステートフル編集** (interaction ID を使用。動画の再アップロード不要)
  - 手持ち動画 (MP4 / WebM、最大 14MB) のアップロード編集。動画は S3 にアップロードして S3 URL で渡します (14MB は Gemini API のリクエスト上限 約 20MB によるものです)
- 画像 (編集元の画像、動画の参照画像 最大 3 枚) の合計 4MB 制限は Lambda 直接 Invoke のペイロード上限 (6MB、base64 で約 4/3 に膨張) によるものです。生成結果を編集素材に再利用する場合は S3 URL で渡すためこの制限を消費しません
- 動画生成は数分かかることがあります (Lambda タイムアウト 15 分)
- EEA (欧州経済領域)・スイス・英国では、アップロードした動画の編集は Gemini API 側で非対応です (生成結果のステートフル編集は可能)
- 動画の interactions API は仕様が変わることがあります (`gemini-omni-flash-preview` は 2026-10-22 に停止済みで、既定は `gemini-omni-1.2-flash` です)

### トラブルシューティング (Gemini)

| 症状                                         | 原因・対処                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Google STS token exchange failed (400)`     | `geminiWifAudience` の形式誤り (プロジェクト **ID** ではなく**番号**を使う)、またはプール / プロバイダ名の不一致              |
| `Service account impersonation failed (403)` | 手順 4 の `roles/iam.workloadIdentityUser` binding 漏れ、または member の指定誤り                                             |
| `403 PERMISSION_DENIED` (画像)               | `aiplatform.googleapis.com` 未有効化、またはサービスアカウントに `roles/aiplatform.user` が無い                               |
| `403 PERMISSION_DENIED` (動画)               | `generativelanguage.googleapis.com` 未有効化、または `roles/serviceusage.serviceUsageConsumer` が無い                         |
| `429`                                        | レート制限。時間を置いて再試行                                                                                                |
| メニューに表示されない                       | `geminiWifAudience` / `geminiServiceAccountEmail` / `geminiProjectId` の 3 つすべてが設定された状態でデプロイされているか確認 |

## GPT Image 画像生成・編集

GenU から OpenAI の Images API を呼び出して、画像生成・編集 (GPT Image ファミリー) を行う機能です。

- 生成: `https://api.openai.com/v1/images/generations`
- 編集: `https://api.openai.com/v1/images/edits`

認証は OpenAI の **API キー** を使います。

```
フロントエンド ──(IAM 直接 Invoke)──▶ invokeGptImage Lambda
        │ OPENAI_API_KEY (環境変数)
        ▼
    api.openai.com (Images API)
```

生成結果は既存の `fileBucket` (S3) に保存され、チャット履歴 (`/gpt-image`) として自動記録されます。

### 必要な設定値

`packages/cdk/cdk.json` の `context` に以下を設定してデプロイすると機能が有効になります。

```json
{
  "context": {
    "openAiApiKey": "sk-...",
    "openAiImageModel": "gpt-image-2.6-sunburst",
    "openAiImageModels": ["gpt-image-2.6-flare", "gpt-image-2"]
  }
}
```

| パラメータ          | 説明                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openAiApiKey`      | OpenAI の API キー。**このパラメータを設定した場合のみ、デプロイ時に `InvokeGptImage` Lambda が作成されます**。未設定 (空文字) の間は Lambda 自体が作成されず、メニューにも表示されません |
| `openAiImageModel`  | 既定の画像モデル。既定 `gpt-image-2.6-sunburst` (高品質)。`gpt-image-2.6-flare` は高速版                                                                                                  |
| `openAiImageModels` | 画像ページのモデル選択に追加で並べるモデル (既定 `[]`)。Lambda はここと `openAiImageModel` に挙げたモデルしか受け付けません                                                               |

> **API キーの取り扱いに注意**: `cdk.json` に記載した API キーはリポジトリにコミットされ得ます。公開リポジトリや外部に共有するリポジトリでは、キーをコミットしないでください。また、キーは `InvokeGptImage` Lambda の環境変数 (CloudFormation テンプレートにも含まれます) として保存されます。

### アーキテクチャ

- **Lambda 直接 Invoke**: 画像生成は API Gateway の統合タイムアウト (29 秒) を超えることがあるため、フロントエンドから `InvokeGptImage` Lambda を IAM 認証 (Cognito Identity Pool) で直接呼び出します (タイムアウト 15 分)。ユーザー識別はペイロードの ID トークンを Lambda 内で検証して行います
- **生成結果の保存**: 生成画像は S3 (`fileBucket`) にアップロードされ、レスポンスには S3 URL のみが含まれます (フロントエンドで署名付き URL に解決)。Invoke ペイロードの 6MB 制限を超えないためです
- **チャット履歴**: 生成のたびにユースケース `/gpt-image` のチャット履歴に記録されます。同一セッション中の連続生成は 1 つのチャットに追記され、`/chat/:chatId` で参照できます

### 機能・制約

- **生成**: テキストから画像を生成。サイズ (自動 / 1024x1024 / 1536x1024 / 1024x1536)、品質 (自動 / 低 / 中 / 高)、生成枚数 (1〜4) を指定可能
- **編集**: 画像 (最大 4 枚 / 合計 4MB) + テキストで編集。ドラッグ&ドロップでのアップロードに対応
- **反復編集**: 生成結果の画像は「この画像を編集」ボタンで編集入力に追加できます。この場合は S3 URL で Lambda に渡され、Lambda 側でバケット内のオブジェクトのみ解決するため、入力 4MB 制限を消費しません
- 入力の合計 4MB 制限は Lambda 直接 Invoke のペイロード上限 (6MB、base64 で約 4/3 に膨張) によるものです

### トラブルシューティング (GPT Image)

| 症状                               | 原因・対処                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `OPENAI_API_KEY is not configured` | `openAiApiKey` が未設定のままデプロイされている。`cdk.json` に設定して再デプロイ |
| `OpenAI Images API error (401)`    | API キーが無効。キーを確認                                                       |
| `OpenAI Images API error (429)`    | レート制限または利用上限。時間を置いて再試行、または OpenAI の利用状況を確認     |
| メニューに表示されない             | `openAiApiKey` が設定された状態でデプロイされているか確認                        |

## 画像生成・編集ページ

Gemini と GPT Image は 1 つのページ (`/image-studio`、メニューの「画像生成・編集」) にまとまっています。通常のチャットと同じ形で、生成結果が上に並び、画面下の入力欄でプロンプトの入力・画像の添付・モデルの選択・詳細設定 (サイズ・品質・アスペクト比・枚数) を行います。モデルの一覧は上記の `geminiImageModel(s)` / `openAiImageModel(s)` で決まり、Gemini → GPT Image の順に並びます。最後に使ったモデルはブラウザごとに記憶されます。

- 画像を添付する (ドラッグ&ドロップ・貼り付け・結果の「この画像を編集」も可) と、その画像の編集になります
- 同じセッションの生成は、途中でモデルを切り替えても 1 つのチャット履歴に追記されます (チャットの種類は最初に使ったプロバイダの `/gemini-image` か `/gpt-image`)
- `/gpt-image` と `/gemini-image` は `/image-studio` に転送されます

動画ページ (`/gemini-video`) も同じ形です。動画を添付するとその動画の編集、画像を添付すると参照画像になります。

以下はこのページで使える機能です。追加の設定は不要です。

### チャット履歴を参照した画像生成

過去のチャットでの会話内容を踏まえて画像を生成する機能です。チャットで議論した結論を 1 枚の絵 (インフォグラフィックなど) にまとめる用途を想定しています。

**使い方**: 入力欄の下の会話アイコン (チャット履歴を選択) からチャットを選ぶと、参照中のチャットが入力欄にチップ表示されます (× で解除)。画像を添付していなければ、AI が会話から枚数と各画像の内容を決めて生成します (構成を考えるモデルは詳細設定で選択)。プロンプトが空の場合は「この会話の結論を、わかりやすい 1 枚の画像にまとめてください」が自動入力されるので、必要に応じて編集して生成します。

**動作の詳細**:

- 選択したチャットのメッセージを `user:` / `assistant:` 形式のトランスクリプトに整形し、リクエストの `chatContext` フィールドで Lambda に送信します
- Lambda はモデル呼び出し時のみトランスクリプトをプロンプトに前置します。**チャット履歴にはユーザーが入力したプロンプトだけが記録される**ため、履歴表示が長文で汚れません
- トランスクリプトには「必ず画像を 1 枚生成する (テキストで回答しない)」という指示が組み込まれるため、「1 枚絵にして」と明示しなくても画像が生成されます
- 会話が長い場合は**結論側 (末尾) を優先して 10,000 文字**に切り詰めます (gpt-image-1 のプロンプト上限 32,000 文字への対策。上限は `packages/web/src/utils/chatContext.ts` の `MAX_TRANSCRIPT_LENGTH` で調整可能)
- チャット選択時にアスペクト比が横長に自動設定されます (Gemini: 16:9 / GPT Image: 16:9 非対応のため最も近い 1536x1024)。手動で変更可能です
- 選択モーダルには画像・動画生成セッション自体の履歴 (`/gpt-image`, `/gemini-image` など) は表示されません

### PDF 一括保存

セッション中に生成したすべての画像を 1 つの PDF ファイルにまとめてダウンロードする機能です。複数回の生成・複数枚出力をまとめて配布資料にする用途を想定しています。

- 生成結果タイムライン右上の「PDF に保存」ボタンで実行します
- 1 画像 = 1 ページで、各ページは画像の実サイズ・向きに合わせて作成されるため画質の劣化はありません
- PDF の生成はブラウザ内 ([jsPDF](https://github.com/parallax/jsPDF)) で完結し、サーバーへの追加リクエストは画像の再取得のみです
