# Web 検索チャット (Amazon Nova web grounding / Amazon Bedrock Web Search)

チャットの下に追加される「Web 検索チャット」(`/web-search`) の説明です。既定では無効で、`webGroundingEnabled` を `true` にしたときだけメニューと画面が表示されます。

## 何をする機能か

通常のチャットと同じ画面ですが、**ユーザーが選んだモデルに `web_search` ツールが渡されます**。

1. ユーザーが質問する
2. モデルが「これは自分の知識だと怪しい / 最新情報が必要」と判断したときだけ `web_search` を呼ぶ
3. バックエンドが、画面で選んだ**検索エンジン**で実際に Web 検索する (下記「検索エンジンの切り替え」)
4. 検索結果の本文と引用元 URL がツール結果としてモデルに戻る
5. モデルがそれを分析して回答し、使った出典を Markdown リンクで引用する

検索するかどうかはモデルの判断なので、雑談や翻訳では検索されません。必要なら 1 回のターンで複数クエリを投げたり、追加で検索し直したりもします。検索した内容と出典は、回答の上に出る折りたたみの「トレース」に表示されます。検索に使ったモデル (Nova / GPT) の名前・検索回数・入力/出力トークンは、回答の下の会話モデルのトークン数の横に 🔍 付きで表示されます (トークンの統計には含めていません)。

### 検索エンジンの切り替え (Nova / GPT)

`web_search` ツールの裏で検索を実行するエンジンを、画面下の入力欄のツールバー (モデル選択の隣) の「検索エンジン」で選べます。会話するモデル自体は変わりません。選択はブラウザごとに保存され (localStorage `webSearchEngine`)、次のメッセージから反映されます。

**GPT が設定されていれば GPT が既定**です。Nova になるのは、ユーザーが明示的に Nova を選んだとき (保存値が `nova`) と、`webGroundingGptModelId` が未設定のときだけです。Lambda 側も同じ判定で、`webSearchEngine` が送られてこないリクエスト (古いタブなど) も GPT で検索します。

| エンジン                        | 中身                                                                                                                                                            | 備考                                                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| GPT (Bedrock Web Search) (既定) | GPT-5.4 以降 (`webGroundingGptModelId`) に **Amazon Bedrock Web Search** (`web_search` サーバーサイドツール) を付けて、`bedrock-mantle` の Responses API で呼ぶ | `webGroundingGptModelId` を設定したときだけ選択肢が出る。検索のやり直しやページ本文の取得まで GPT 側で行うので、時間がかかることがある |
| Amazon Nova                     | Nova 2 (`webGroundingModelId`) の **web grounding システムツール** を Converse API で呼ぶ                                                                       | 常に使える。GPT 未設定時はこれだけになる                                                                                               |

GPT エンジンの実装メモ:

- Web Search は `bedrock-mantle` エンドポイントの **Responses API 専用**で、Converse API / `bedrock-runtime` からは使えません。そのため `bedrockWebSearchApi.ts` が Lambda 実行ロールの認証情報で **SigV4 署名 (サービス名 `bedrock-mantle`) した fetch** で直接呼びます。Bedrock API キーや OpenAI SDK は使いません。
- `external_web_access: false` を**必ず明示**しています。既定値は `true` で、その場合は `bedrock-websearch:ExternalWebAccess` 権限がないとページ取得 (Fetch) が全部失敗します。`false` なら検索は Bedrock の Web インデックスとキャッシュだけで完結し、データが AWS の外に出ません。
- `reasoning.effort` は `low`、`store: false` (レスポンスをサーバー側に保存しない) で呼んでいます。`user_location` は指定していません。
- GPT は出典を本文中に Markdown リンクで書き、`url_citation` 注釈はそのリンク部分を指します。そこで、**出典リンクを含む段落 = その出典に裏付けられた `<excerpt>`、リンクのない段落 = `<unsourced>`** として Nova と同じ形のツール結果に変換しています。GPT が内部で実際に投げた検索語はトレースに `↳` で表示されます。
- GPT エンジンの検索はクロスアカウント (`crossAccountBedrockRoleArn`) には対応していません。常に Lambda 自身のロールで呼びます。

### 役割分担 (検索側には考えさせない)

Nova (検索側) に「A と B の違い」のような**複雑な問いをそのまま投げるとハルシネーションします**。似た名前の会社を同一視する、出典にない親子関係をでっち上げる、といった形で誤りが混ざり、それを本体モデルが事実として受け取ってしまいます。

そのため役割を次のように分けてあります。

- **検索エンジン = 単純な検索と抜き出しだけ**。1 クエリ 1 主題・1 論点に限定し、出典が実際に書いていることをそのまま報告させます (`groundingSystemPrompt()`)。
- **比較・統合・結論は本体モデル (Claude など) の仕事**。複雑な質問は主題ごとの単純クエリに分解してから検索させます (`web_search` のツール説明とシステムプロンプト)。
- ツール結果は**出典付きの `<excerpt sources="1,2">` と、出典のない `<unsourced>` に分けて**返します。後者は検索エンジンが自分の言葉で書いた部分＝作話しやすい箇所なので、本体モデルには「未確認のヒント扱いにする」「1 つの excerpt が直接書いていない限り、2 つのものを関連付けない」と指示しています。

### 今日の日付を教える

モデルは**今日が何日か知りません**。放っておくと学習データの時点を「今」だと思い込み、次の 2 つの失敗をします。

- 検索クエリに過去の年を入れる
- 学習時点より後の正しい情報を「未来の日付だからガセ記事だろう」と切り捨てる

そのため両方に現在日付を渡しています。

- 本体モデル: `claudePrompter.systemContext('/web-search')` が `/web-search` のときだけ日付の注記を末尾に足します (ブラウザのローカル日付、リクエストごとに評価)。
- 検索エンジン (Nova / GPT) と `web_search` ツール定義: Lambda 側で UTC の日付を埋め込み (`webGroundingApi.ts` の `today()`)、「過去の年をクエリに入れない」「更新の新しいページを優先し、年や『時点』が書いてあれば必ず添える」と指示します。

会話はそのまま続けられ、履歴も通常のチャットと同じように保存されます。ただし履歴から開き直すと `/chat/:chatId` になるため、そこでの続きは**検索なしの普通のチャット**になります (他のユースケースと同じ挙動です)。

参考: [Amazon Nova web grounding (AWS ドキュメント)](https://docs.aws.amazon.com/ja_jp/nova/latest/nova2-userguide/web-grounding.html) / [Amazon Bedrock Web Search (AWS ドキュメント)](https://docs.aws.amazon.com/bedrock/latest/userguide/web-search.html)

## 有効化

`packages/cdk/cdk.json` の `context` (または `parameter.ts`) に以下を設定してデプロイします。`webGroundingEnabled` が `true` のときだけ Lambda (`WebGroundingStream`) が作成され、メニューとルートが現れます。`false` (既定値) の場合は**リソースを一切作りません**。

### cdk.json での設定例

```json
{
  "context": {
    "webGroundingEnabled": true,
    "webGroundingModelId": "us.amazon.nova-2-lite-v1:0",
    "webGroundingRegion": "us-east-1",
    "webGroundingGptModelId": "openai.gpt-6.1-terra",
    "webGroundingGptRegion": "us-east-1"
  }
}
```

### parameter.ts での設定例

```typescript
const envs: Record<string, Partial<StackInput>> = {
  dev: {
    webGroundingEnabled: true,
    // GPT エンジンも使う場合のみ
    webGroundingGptModelId: 'openai.gpt-6.1-terra',
  },
};
```

| パラメータ               | 既定値                       | 説明                                                                                                                                                                                                   |
| ------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `webGroundingEnabled`    | `false`                      | 機能全体の ON/OFF                                                                                                                                                                                      |
| `webGroundingModelId`    | `us.amazon.nova-2-lite-v1:0` | 検索を実行する Nova 2 モデル                                                                                                                                                                           |
| `webGroundingRegion`     | `us-east-1`                  | 上記モデルを呼ぶリージョン                                                                                                                                                                             |
| `webGroundingGptModelId` | `''` (GPT エンジンなし)      | GPT エンジンで使うモデル。`bedrock-mantle` での ID (`openai.gpt-6.1-terra` のように `us.` / `global.` を付けない)。GPT-5.4 以降で、モデルカードにサーバー側ツール対応とあるもの (GPT-6.1 Sol は非対応) |
| `webGroundingGptRegion`  | `us-east-1`                  | GPT エンジンを呼ぶリージョン (`us-east-1` / `us-east-2` / `us-west-2` のみ)                                                                                                                            |

設定後、`npm run cdk:deploy` でデプロイします。

## 制約と注意点

- **US 限定**: web grounding は US リージョン / US CRIS プロファイル (`us.` 接頭辞) の Nova 2 モデルでしか使えません。`webGroundingRegion` を US 以外にすると失敗します。会話側のモデル (`modelIds`) は今までどおり任意のリージョンで構いません。
- **GPT エンジンも US 限定**: Bedrock Web Search は us-east-1 / us-east-2 / us-west-2 の GPT-5.4 以降でしか使えません。モデルによっては使えるリージョンがさらに限られます (GPT-6.1 Terra は us-east-1 のみ)。Lambda ロールには `bedrock-mantle:CreateInference` と `bedrock-websearch:InvokeSearch` / `InvokeFetch` を付与しています (`ExternalWebAccess` は付けていません)。SCP で `bedrock-mantle:*` や `bedrock-websearch:*` を拒否していると失敗します。
- **SCP に注意**: web grounding の呼び出しは `aws:requestedRegion` が `unspecified` で届きます。リージョンを固定する SCP / IAM ポリシーがあるとブロックされます (エラーはトレースに出ます)。
- **追加課金**: 検索 1 回ごとに web grounding / Web Search の料金がかかります。GPT エンジンでは、これに加えて GPT 自体の推論トークン料金もかかります ([Amazon Bedrock の料金](https://aws.amazon.com/jp/bedrock/pricing/))。検索回数には上限を設けてあります (1 メッセージあたり最大 5 ラウンド)。
- **出典の表示は必須**: AWS の利用条件として、グラウンディング結果を出すときは引用とリンクを残す必要があります。システムプロンプトとツール結果の両方でモデルに指示していますが、システムプロンプトを書き換える場合はこの指示を消さないでください。
- **モデルの選択肢**: Converse API のツール利用が前提なので、SageMaker エンドポイントはこのページでは選べません。また、ツール利用に対応していない Bedrock モデルを選ぶとエラーになります (Claude / Nova / GPT などは対応しています)。モデルと検索エンジンは、通常のチャットと同じく画面下の入力欄で選びます。
- **英語以外での検索**: AWS のドキュメントによると、間接プロンプトインジェクションや誤情報に対する実行時フィルタは英語以外では効果が限定的とされています。

## 実装の場所

| 役割                                              | ファイル                                             |
| ------------------------------------------------- | ---------------------------------------------------- |
| ストリーミング Lambda (直接 invoke)               | `packages/cdk/lambda/webGroundingStream.ts`          |
| ツールループと Nova 呼び出し                      | `packages/cdk/lambda/utils/webGroundingApi.ts`       |
| GPT (Bedrock Web Search) 呼び出し                 | `packages/cdk/lambda/utils/bedrockWebSearchApi.ts`   |
| Lambda の条件付き作成                             | `packages/cdk/lib/construct/api.ts`                  |
| パラメータ定義                                    | `packages/cdk/lib/stack-input.ts`                    |
| 画面 (ChatPage の薄いラッパー + 検索エンジン選択) | `packages/web/src/pages/WebSearchChatPage.tsx`       |
| 有効判定・パス定義・検索エンジンの保存            | `packages/web/src/hooks/useWebGrounding.ts`          |
| 呼び出し先 Lambda の切り替え + 検索エンジンの送信 | `packages/web/src/hooks/useChatApi.ts`               |
| システムプロンプト                                | `packages/web/src/prompts/claude.ts` (`/web-search`) |
