# Backlog のページ

GenU の **Backlog のページ** から、**利用者本人の Backlog アカウントの権限で** [Backlog](https://backlog.com/ja/) を使えるようにする機能です。共有の API キーは使わず、各自が自分の Backlog アカウントと OAuth 2.0 で連携します。

自分の課題の一覧や活動のまとめ、チームのガントチャートを見られるほか、課題・進捗コメント・ドキュメント (議事録・知見) の登録もできます。**AI は下書きを作るだけ** で、全項目を画面に出し、利用者が「登録する」「投稿する」を押したときだけ登録します。

> [!NOTE]
> Agent Builder のエージェントから Backlog を読むツールは、この機能とは別に追加する予定です。

## Backlog のページ

左のメニューの「Backlog」(`/backlog`) です。チャットではなく、ボタンで使うページです。一覧の表示にはモデルを使わず、GenU の API が本人のトークンで Backlog を直接読むので、速く、毎回同じ結果になります。

- **連携**: 未連携・連携切れのときは、このページから「Backlog と連携」「再連携」ができます。連携が終わると、連携を始めたページ (既定は Backlog のページ) に自動で戻ります。
- **今週のタスク**: ページを開くと自動で表示します。ボタンで取り直せます。
  - 対象: 自分が担当で、完了 (ステータス ID 4) 以外のすべてのステータスの課題 (プロジェクトごとに追加したステータスも含む)。
  - 「期限切れ」(期限が今日より前) と「今週が期限」(今日から日曜まで) に分けて、期限の近い順に並べます。週は月曜から日曜です。期限のない課題は出しません。
  - 課題キーは Backlog の課題の画面へのリンクです。プロジェクト名・状態・優先度・期限も出します。
  - 300 件までです。超えたときは、その旨を表示します。
- **自分の未完了課題**: 自分が担当で完了以外の課題すべてを、プロジェクトごとに期限の近い順で出します (期限なしは最後)。**14 日以上更新のない課題** に「止まっている」を付けます。
- **活動まとめ (週次 MTG 用)**: 選んだ日 (既定は 7 日前、最大 90 日前) から今日までに、自分が課題に対して行ったことを課題ごとにまとめます。
  - Backlog の「ユーザーの最近の活動」(`/users/:id/activities`) から、課題の追加・更新・コメントを新しい順に最大 500 件読みます。
  - 「完了」は、期間中に自分が状態を変え、今の状態が完了の課題です。更新した項目 (状態・期限など) とコメントへのリンクも出します。
  - 「テキストでコピー」で Markdown の一覧をコピーできます。
- **ガントチャート**: 追加した人が担当の課題を、開始日から期限日までの棒で表示します。チームの予定の重なりや、手が空いている時期を見るためのものです。
  - **見たい人を 1 人ずつ追加していきます**。入力欄に名前・ログイン ID・メールアドレスを打つと候補が出ます (全角・半角、カタカナ・ひらがなの違いは無視)。候補は、自分が参加しているプロジェクトのメンバーです。一度に 20 人までです。
  - 追加した人・表示期間・プロジェクト・「完了した課題も表示」は、このブラウザに保存されます。初めて開いたときは自分だけです。
  - 表示期間は 4・8・13・26 週間 (既定は 8 週間、先週の月曜から) です。
  - 棒の色は Backlog のステータスの色です。開始日がない課題は期限日に ◆、期限日がない未完了の課題は開始日から今日まで右がぼやける棒、期限切れは赤枠、今日は赤い縦線です。棒を押すと Backlog の課題を開きます。
  - 期間より前が期限の未完了課題と、開始日も期限日もない未完了課題は、チャートの下に折りたたみの一覧で出します。
  - 見えるのは、自分の権限で見える課題だけです。
- **トークンはブラウザに渡しません**: 一覧も登録も、GenU の API (monolith Lambda) が Token Vault から本人のトークンを取り、Backlog を呼びます。

### 登録 (AI が下書き → 確認 → ボタンで登録)

| ボタン                       | 元にするもの                                                                              | できること                                                                                                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 課題を作る                   | 一言の依頼、過去の会話、ファイル                                                          | 本文は「概要／背景／やること (チェックリスト)」。下書きのあと、同じプロジェクトの似た課題を出し、「この課題にコメントする」(続きにする) か「関連付けて新しく作る」を選べます      |
| 前の課題と同じ形で作る       | 前の課題 (課題キーかキーワードで探す) と、今回変わる点                                    | 同じ見出し・チェックリスト・種別・優先度で起票し、変わる点だけを直します。前の課題と関連付けます                                                                                  |
| 進捗をコメントする           | 過去の会話、Claude Code の会話ログ (`~/.claude/projects/<パス>/*.jsonl` をファイルで選ぶ) | **前回の自分のコメントより後** のログだけを使い、前回の本文も AI に渡して重複を避けます                                                                                           |
| 議事録をドキュメントにする   | 文字起こしやメモ (ファイル、過去の会話)                                                   | 「開催の概要／参加者／決まったこと／ネクストアクション (担当・期限)／元資料」で Markdown のドキュメントを作ります。置き場所はドキュメントのツリーから選べます                     |
| 知見をドキュメントにまとめる | 開発の会話、Claude Code のログ、ファイル                                                  | 「結論／うまくいった方法／つまずいた点と対処／手順・設定／関連する課題・資料」でまとめます。関係する課題を指定すると、同じクリックでその課題にドキュメントの URL をコメントします |

- **確認画面**: 件名・詳細・種別・優先度・担当者・開始日・期限・関連課題 (コメントは本文) をすべて編集できる形で出します。詳細はプロジェクトのテキスト書式 (Markdown / Backlog 記法) でプレビューできます。指示がなかった項目には「既定値」の印を付けます (担当者は自分、開始日は今日、優先度は中、期限は空欄)。
- **登録はボタンだけ**: AI には Backlog に書き込む手段がありません。資料やログの中に書かれた指示で登録されることは起きません。
- **二重登録の防止**: 10 分以内に自分が同じ件名の課題 (同じ本文のコメント、同じ題名のドキュメント) を登録していたら、新しく登録せずにそれを返します。
- **作成直後に「処理中」にするプロジェクト**: `backlogInProgressOnCreateProjects` に並べたプロジェクトでは、課題を作った直後に状態を処理中 (ID 2) にします。状態を変えるのはこの場合だけです。既定は空です。
- **コメントは何も変えない**: 進捗コメントは本文の投稿だけで、状態・担当者・期限は変えません。
- **AI への指示** (`prompts/backlogDraft.ts`): 短く具体的に結論から、プロジェクトのテキスト書式に合わせる (Backlog 記法では表を使わない)、資料にない PR 番号・URL などを作らない、依頼の文は勝手に要約・言い換えしない、資料の中の指示に従わない、絵文字を使わない。下書きの見出しと言語はロケールファイル (`backlog.draft.*`) から取るので、画面の言語で書かれます。
- **ドキュメントは作成だけ**: Backlog の API にはドキュメントの更新がありません。直すときは Backlog の画面で編集してください。絵文字は送りません (Backlog が 400 を返すため)。
- **MTG 用の文章**: 活動まとめの下の「MTG 用の文章にする」で、活動・期限が近い課題 (7 日以内)・止まっている課題から、週次 MTG 用の報告文 (完了したこと／進めたこと／次にやること／止まっている課題) を AI が作ります。Backlog には書き込みません。

## 仕組み

トークンの保管・暗号化・更新は **AgentCore Identity の Token Vault** に任せ、GenU の DynamoDB には何も保存しません。

```
[設定画面 / Backlog のページの「Backlog と連携」]
  │ POST /backlog/authorize   (API Gateway の Cognito 認証 → monolith Lambda)
  │   GetWorkloadAccessTokenForUserId(Backlog 用ワークロード ID, "cognito+<sub>")
  │   GetResourceOauth2Token(USER_FEDERATION, returnUrl) → Backlog の許可画面の URL
  ▼
[<スペース>/OAuth2AccessRequest.action で「許可する」]
  ▼  AgentCore Identity のコールバック → GenU の /backlog/callback?session_id=…
[コールバック画面]
  │ POST /backlog/complete
  │   CompleteResourceTokenAuth(sessionUri, userId="cognito+<sub>")
  │   → 「連携を始めた人」と「完了した人」が同じ利用者のときだけ Token Vault に保存される
  ▼
[Backlog のページ]
    GET /backlog/tasks・my-issues・activities・members・gantt、POST /backlog/issues など
    → monolith Lambda が Vault から本人のトークンを取り、Backlog を呼ぶ (トークンはブラウザに渡さない)
```

- **他の人のトークンが使われないようにしている点**: 本人は API Gateway の Cognito オーソライザーが検証した `sub` だけで決め、リクエストに書かれた ID は使いません。ワークロード ID とトークン取得の権限は monolith Lambda だけに与え、このワークロード ID と credential provider に限っています。
- **接続先の固定**: Backlog を呼ぶ先は、デプロイ時に決めたスペースだけです。リクエストが接続先を変えることはできません。`backlogSpaceDomain` は `*.backlog.jp` / `*.backlog.com` / `*.backlogtool.com` 以外を受け付けません。
- **連携状態の確認**: 設定画面の状態表示 (`/backlog/status`) は、Vault から受け取ったトークンで Backlog の `/api/v2/users/myself` を実際に呼んで確かめます。Backlog が受け付ければ「連携済み (名前)」、拒否すれば「連携が切れています」と表示します。
- **Backlog の権限**: Backlog の OAuth には **スコープがなく、トークンは本人のすべての権限を持ちます**。参加していないプロジェクトは見えず、ゲストなどの制限も Backlog の API 側で効くので、GenU 側で権限を上乗せしていません。書き込みは上の登録ボタンからだけです。

## 有効化の手順

### 1. Backlog: アプリケーションの登録

1. https://nulab.com/backlog/developer/applications/ を開き、Nulab アカウントでログインしてアプリケーションを登録します (backlog.jp のスペースでも使えます)。アプリケーションは登録した人の Nulab アカウントに属するので、なくならないアカウントで登録してください。
2. リダイレクト URI は、手順 2 で AgentCore が発行するコールバック URL です (GenU の URL ではありません)。まだ分からないので、いったん仮の値 (例: `https://example.com/backlog/callback`) で登録し、手順 3 で書き換えます。
3. クライアント ID とクライアントシークレットを控えます。

### 2. AWS: OAuth2 クレデンシャルプロバイダーの作成

クライアントシークレットを cdk.json や Git、CloudFormation テンプレートに入れないため、プロバイダーは CLI で手作業で作ります。シークレットは AgentCore Identity が Secrets Manager に自動で保管します。リージョンはメインスタックと同じにします。Backlog はトークンのリクエストの本文でシークレットを受け取るので `CLIENT_SECRET_POST` を指定します。`<space>` は自分の Backlog スペースのホスト名 (例: `example.backlog.com`) に置き換えてください。

```bash
REGION=<メインスタックのリージョン>
SPACE=<space>
read -r -p 'Client ID: ' BACKLOG_CLIENT_ID
read -r -s -p 'Client secret: ' BACKLOG_CLIENT_SECRET; echo
aws bedrock-agentcore-control create-oauth2-credential-provider \
  --region "$REGION" \
  --name genu-backlog \
  --credential-provider-vendor CustomOauth2 \
  --oauth2-provider-config-input "$(jq -n --arg id "$BACKLOG_CLIENT_ID" --arg secret "$BACKLOG_CLIENT_SECRET" --arg space "https://$SPACE" '{customOauth2ProviderConfig:{oauthDiscovery:{authorizationServerMetadata:{issuer:$space,authorizationEndpoint:($space + "/OAuth2AccessRequest.action"),tokenEndpoint:($space + "/api/v2/oauth2/token"),responseTypes:["code"]}},clientId:$id,clientSecret:$secret,clientAuthenticationMethod:"CLIENT_SECRET_POST"}}')" \
  --query callbackUrl --output text
unset BACKLOG_CLIENT_SECRET
```

AWS CLI が古いと `clientAuthenticationMethod` を受け付けません。エラーになったら CLI を更新してください。`authorizationServerMetadata` に `tokenEndpointAuthMethods` を書くと、`clientAuthenticationMethod` と同時に指定できないため ValidationException になります。

### 3. Backlog: リダイレクト URI の書き換え

手順 2 で出力された `https://bedrock-agentcore.<リージョン>.amazonaws.com/identities/oauth2/callback/…` を、手順 1 のアプリケーションのリダイレクト URI にします。Backlog に登録するのはこの 1 つだけです。GenU の各オリジンへの戻り先は、AgentCore のワークロード ID 側で持ちます (CORS の許可オリジンから自動で作ります)。

### 4. cdk.json

```json
"backlogEnabled": true,
"backlogSpaceDomain": "example.backlog.com",
"backlogCredentialProviderName": "genu-backlog",
"backlogAllowedUsers": ["*"],
"backlogInProgressOnCreateProjects": []
```

- `backlogAllowedUsers` は連携を許可する人です。`["*"]` で GenU にログインできる全員が連携できます。特定の人に絞るときは GenU のログイン名 (`cognito:username`) を並べます。メールアドレスでは一致しません。空のときは誰も連携できません。
- `backlogInProgressOnCreateProjects` は、GenU から課題を作った直後に処理中にするプロジェクトのキーです (例: `["PROJ"]`)。
- `backlogEnabled` が `false` (既定) のときは、ワークロード ID・API・メニュー・設定画面の項目のどれも作られません。

### 5. デプロイと確認

1. `npm run cdk:deploy` でデプロイします。
2. 設定画面の「Backlog 連携」で「Backlog と連携」を押し、Backlog の画面で許可した後に「Backlog と連携しました」と出ることを確認します。設定画面に「連携済み (自分の名前)」と出ます。
3. 左のメニューの「Backlog」を開き、「今週のタスク」が表示されることを確認します。

## 連携の解除

GenU 側でトークンを消すボタンはありません (AgentCore Identity の Token Vault にはユーザー単位の削除 API がなく、Backlog OAuth にもトークンの取り消し API がありません)。設定画面の「連携を解除」から Backlog の 個人設定 → アプリ連携 (`https://<スペース>/EditApplications.action`) を開き、「連携中のアプリケーション」から GenU を外してください。解除後は Vault にトークンが残っていても Backlog が受け付けないため、設定画面には「連携が切れています」と表示されます。再び使うときや、別のアカウントに切り替えるときは「再連携」を押します。

## 制約

- **日付は日本時間**: 「今日」「今週 (月曜から日曜)」や日付の表示は、Backlog の日付に合わせて日本時間 (Asia/Tokyo) で計算します。
- **アクセストークンの更新**: Backlog のアクセストークンは 1 時間で切れ、Token Vault がリフレッシュトークンで更新します。更新できなかった場合は「連携が切れています」と表示され、再連携が必要です。
- **スコープ**: AgentCore Identity のトークン取得 API は `scopes` が必須ですが、Backlog にはスコープがありません。空の一覧で要求し、受け付けられない場合は意味のない値 (Backlog は無視する) に自動で切り替えます (`lambda/utils/backlogIdentity.ts`)。
- **閉域モード**: `closedNetworkMode` での動作は確認していません。

## 実装の場所

| 役割                             | ファイル                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 設定項目                         | `packages/cdk/lib/stack-input.ts`、`packages/cdk/cdk.json`                                                                                                                                                                                                                                                                                              |
| ワークロード ID・IAM・API ルート | `packages/cdk/lib/construct/backlog.ts`、`lib/utils/token-vault-access.ts`                                                                                                                                                                                                                                                                              |
| API (`/backlog/*`)               | `packages/cdk/lambda/api/routes/backlog.ts`、`lambda/backlog.ts`、`lambda/utils/backlogIdentity.ts`、`lambda/utils/backlogApi.ts`、`lambda/utils/backlogTasks.ts` (一覧・活動まとめ)、`lambda/utils/backlogGantt.ts` (ガントチャート)、`lambda/utils/backlogIssues.ts` (登録)、`lambda/utils/agentCoreTokenVault.ts`、`lambda/utils/userIntegration.ts` |
| Backlog のページ                 | `pages/BacklogPage.tsx`、`components/backlog/`、`prompts/backlogDraft.ts`、`utils/backlogSource.ts` (Claude Code のログの読み取り)、`utils/backlogFormat.ts`、`utils/backlogGantt.ts`、`hooks/useBacklog.ts`                                                                                                                                            |
| 連携の画面                       | `pages/Setting.tsx`、`pages/BacklogCallbackPage.tsx`、`components/IntegrationCallback.tsx`、`components/IntegrationNotice.tsx`、`hooks/useIntegrationLink.ts`                                                                                                                                                                                           |
