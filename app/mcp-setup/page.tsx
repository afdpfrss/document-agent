// MCP サーバー接続ガイド — 利用者が自分の生成 AI に、この社内ドキュメント検索を
// リモート MCP コネクタとして登録するための手順ページ（v2 設計 §4-F の提供レイヤー）。
//
// MCP サーバー URL はリクエストのホストから動的生成する（baseUrlFromHeaders）。
// これによりホスティング先（Vercel / Cloudflare / 独自ドメイン等）が変わっても、
// 移行後のドメインでこのページを開けば常に正しい URL が表示される。

import { headers } from "next/headers";
import { baseUrlFromHeaders, isMcpAuthEnabled } from "@/lib/mcp/oauth";
import { CopyButton } from "@/components/CopyButton";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "MCP サーバーの接続方法",
};

// クライアント別の設定手順を最後に見直した日。各サービスの UI 変更には自動追従
// できないため、この日付をページに明示して「いつ時点の情報か」を読者へ伝える。
const LAST_UPDATED = "2026-05-22";

export default async function McpSetupPage() {
  const h = await headers();
  const base = baseUrlFromHeaders(h) ?? "http://localhost:3000";
  const mcpUrl = `${base}/api/mcp`;
  const discoveryUrl = `${base}/.well-known/oauth-protected-resource`;
  const authEnabled = isMcpAuthEnabled();

  // 各クライアントの設定スニペット。URL は動的生成した mcpUrl を埋め込む。
  const claudeCodeCmd = `claude mcp add --transport http document-agent ${mcpUrl}`;

  const cursorJson = `{
  "mcpServers": {
    "document-agent": {
      "url": "${mcpUrl}"
    }
  }
}`;

  const vscodeJson = `{
  "servers": {
    "document-agent": {
      "type": "http",
      "url": "${mcpUrl}"
    }
  }
}`;

  const geminiCliJson = `{
  "mcpServers": {
    "document-agent": {
      "httpUrl": "${mcpUrl}"
    }
  }
}`;

  const windsurfJson = `{
  "mcpServers": {
    "document-agent": {
      "serverUrl": "${mcpUrl}"
    }
  }
}`;

  const anthropicApi = `curl https://api.anthropic.com/v1/messages \\
  -H "x-api-key: $ANTHROPIC_API_KEY" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "anthropic-beta: mcp-client-2025-04-04" \\
  -H "content-type: application/json" \\
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "messages": [
      { "role": "user", "content": "有給休暇の付与日数を教えて" }
    ],
    "mcp_servers": [
      {
        "type": "url",
        "name": "document-agent",
        "url": "${mcpUrl}"
      }
    ]
  }'`;

  const openaiApi = `from openai import OpenAI

client = OpenAI()
resp = client.responses.create(
    model="gpt-5",
    input="有給休暇の付与日数を教えて",
    tools=[
        {
            "type": "mcp",
            "server_label": "document-agent",
            "server_url": "${mcpUrl}",
            "require_approval": "never",
        }
    ],
)
print(resp.output_text)`;

  const geminiApi = `import asyncio
from google import genai
from google.genai import types
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def main():
    async with streamablehttp_client("${mcpUrl}") as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            client = genai.Client()
            resp = await client.aio.models.generate_content(
                model="gemini-2.5-pro",
                contents="有給休暇の付与日数を教えて",
                config=types.GenerateContentConfig(tools=[session]),
            )
            print(resp.text)

asyncio.run(main())`;

  return (
    <article className="w-full max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">
          MCP サーバーの接続方法
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-slate-600">
          この社内ドキュメント検索は、段階的開示で文書を検索できる
          <strong>リモート MCP サーバー</strong>
          として公開されています。お使いの生成 AI に MCP コネクタとして登録すると、
          AI が直接ドキュメントを検索・引用できるようになります。回答の生成はお使いの
          AI 側で行われ、このサーバーは検索・編集ツールのみを提供します。
        </p>
        <div className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800">
          本ページのクライアント別の設定手順は <strong>{LAST_UPDATED}</strong>{" "}
          時点の情報です。各サービスの画面構成・項目名は変更されることがあるため、
          うまくいかない場合は各公式ドキュメントの最新情報もあわせてご確認ください。
        </div>
      </header>

      {/* --- MCP サーバー URL（動的生成） --- */}
      <section>
        <h2 className="mt-2 mb-2 text-base font-bold text-slate-900">
          MCP サーバー URL
        </h2>
        <p className="mb-2 text-sm leading-relaxed text-slate-600">
          各クライアントの設定にはこの URL を使います。現在アクセスしているドメインから
          自動生成しているため、ホスティング先（クラウド）が変わっても、移行後のドメインで
          このページを開けば常に最新の URL が表示されます。
        </p>
        <UrlBox url={mcpUrl} />
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          トランスポートは Streamable HTTP です。OAuth の自動検出に対応したクライアントは
          設定不要ですが、ディスカバリ URL は{" "}
          <Code>{discoveryUrl}</Code> です。
        </p>
      </section>

      {/* --- 認証 --- */}
      <section>
        <h2 className="mt-10 mb-2 text-base font-bold text-slate-900">
          認証について
        </h2>
        <div className="mb-2">
          <span
            className={
              authEnabled
                ? "inline-block rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800"
                : "inline-block rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
            }
          >
            {authEnabled ? "現在の状態: 認証 有効" : "現在の状態: 認証 なし"}
          </span>
        </div>
        {authEnabled ? (
          <p className="text-sm leading-relaxed text-slate-600">
            この MCP サーバーは OAuth 2.1 で保護されています。Claude や ChatGPT
            などの対応クライアントは、コネクタ登録時に自動でブラウザ認証
            （Google ログイン）を行います。動的クライアント登録（DCR）と PKCE
            に対応しているため、<Code>client_id</Code> 等を手動で設定する必要は
            ありません。実際に接続できるのは、許可リスト
            （<Code>MCP_ALLOWED_EMAILS</Code> /{" "}
            <Code>MCP_ALLOWED_EMAIL_DOMAINS</Code>）に含まれる社内アカウントのみです。
          </p>
        ) : (
          <p className="text-sm leading-relaxed text-slate-600">
            現在この環境は認証なし（ローカル開発 / デモ構成）で動作しています。
            アクセストークンは不要で、上記 URL を登録すればそのまま接続できます。
            社内機密文書を含む本番デプロイでは、必ず認証を有効化してください。
          </p>
        )}
      </section>

      {/* --- 提供ツール --- */}
      <section>
        <h2 className="mt-10 mb-2 text-base font-bold text-slate-900">
          このサーバーで使えるツール
        </h2>
        <p className="mb-2 text-xs text-slate-500">読み取り（誰でも利用可）</p>
        <ul className="mb-3 space-y-1 text-sm text-slate-700">
          <ToolItem name="search_documents">
            質問に関連する候補ドキュメントを、フロントマター（タイトル・要約・見出し）
            のみで絞り込む。
          </ToolItem>
          <ToolItem name="get_sections">
            候補から読むべきセクションを選び、その本文を取得する。
          </ToolItem>
          <ToolItem name="list_categories">
            ドキュメントのカテゴリ一覧と文書数を確認する。
          </ToolItem>
        </ul>
        <p className="mb-2 text-xs text-slate-500">
          編集・レビュー（編集権限が必要）
        </p>
        <ul className="space-y-1 text-sm text-slate-700">
          <ToolItem name="propose_edit">
            1 つの文書に <Code>{"{find, replace, reason}"}</Code>{" "}
            の構造化編集を適用し、GitHub PR を作成する。
          </ToolItem>
          <ToolItem name="find_text_occurrences">
            同じ記述がどの文書に存在するかを全件検索する（横展開の事前確認）。
          </ToolItem>
          <ToolItem name="propose_related_edit">
            複数の関連文書へまとめて修正を入れる PR を作成する。
          </ToolItem>
          <ToolItem name="ingest_documents">
            新規ドキュメントをコーパスに追加する PR を作成する。
          </ToolItem>
          <ToolItem name="review_edit">
            PR の差分・CI・承認状況を取得する。
          </ToolItem>
          <ToolItem name="merge_edit">
            ゲート（CI・承認・提案者≠承認者）を満たした PR をマージする。
          </ToolItem>
        </ul>
      </section>

      {/* --- クライアント別 設定手順（生成 AI ごとに開閉可能） --- */}
      <section>
        <h2 className="mt-10 mb-1 text-base font-bold text-slate-900">
          生成 AI / クライアント別の設定手順
        </h2>
        <p className="mb-3 text-xs text-slate-500">
          各項目をクリックすると開閉できます。
        </p>

        <div className="space-y-2">
          <ClientSection title="Claude（claude.ai / Web）" tag="アプリ">
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                claude.ai 右下のアカウントメニュー →「設定」→「コネクタ」を開く。
              </li>
              <li>「カスタムコネクタを追加」をクリックする。</li>
              <li>
                名前（例: 社内ドキュメント検索）と「リモート MCP サーバー URL」
                に下記の URL を入力する。
              </li>
              <li>
                追加後、コネクタを有効化する。認証が有効な環境では、初回接続時に
                ブラウザで Google ログインを求められる。
              </li>
            </ol>
            <UrlBox url={mcpUrl} />
            <Note>
              カスタムコネクタは Pro / Max / Team / Enterprise など対象プランで
              利用できます。
            </Note>
          </ClientSection>

          <ClientSection title="Claude デスクトップアプリ" tag="アプリ">
            <ol className="list-decimal space-y-1 pl-5">
              <li>Claude デスクトップアプリの「設定」→「コネクタ」を開く。</li>
              <li>「カスタムコネクタを追加」を選択する。</li>
              <li>リモート MCP サーバー URL に下記を入力して追加する。</li>
            </ol>
            <UrlBox url={mcpUrl} />
            <Note>
              ローカル（stdio）の MCP サーバーとは別枠の「リモートコネクタ」として
              登録します。
            </Note>
          </ClientSection>

          <ClientSection title="Claude Code（CLI）" tag="CLI">
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                ターミナルで次のコマンドを実行する（プロジェクト直下で実行すると{" "}
                <Code>.mcp.json</Code> に保存される）。
              </li>
            </ol>
            <CodeBlock code={claudeCodeCmd} />
            <ol className="list-decimal space-y-1 pl-5" start={2}>
              <li>
                <Code>claude</Code> を起動し <Code>/mcp</Code>{" "}
                で接続状態を確認する。認証が有効ならブラウザ認証フローが走る。
              </li>
            </ol>
          </ClientSection>

          <ClientSection title="ChatGPT（OpenAI）" tag="アプリ">
            <ol className="list-decimal space-y-1 pl-5">
              <li>
                ChatGPT の「設定」→「コネクタ」（または「アプリとコネクタ」）を開く。
              </li>
              <li>開発者モードを有効化し、「カスタムコネクタを作成」を選択する。</li>
              <li>
                MCP サーバー URL に下記を入力し、認証方式（OAuth）を選んで接続する。
              </li>
            </ol>
            <UrlBox url={mcpUrl} />
            <Note>
              カスタム MCP コネクタの利用可否は、プラン・地域・開発者モードの
              提供状況に依存します。
            </Note>
          </ClientSection>

          <ClientSection title="Cursor" tag="IDE">
            <p>
              プロジェクト直下の <Code>.cursor/mcp.json</Code>
              （全体に効かせる場合は <Code>~/.cursor/mcp.json</Code>）に追記:
            </p>
            <CodeBlock code={cursorJson} />
            <p>
              保存後、Cursor の Settings → MCP で <Code>document-agent</Code>{" "}
              が緑（接続済み）になることを確認します。
            </p>
          </ClientSection>

          <ClientSection title="VS Code（GitHub Copilot）" tag="IDE">
            <p>
              ワークスペースの <Code>.vscode/mcp.json</Code> に追記:
            </p>
            <CodeBlock code={vscodeJson} />
            <p>
              コマンドパレットの「MCP: List Servers」から起動・認証できます。
              Copilot のエージェントモードでツールが使えるようになります。
            </p>
          </ClientSection>

          <ClientSection title="Google Gemini CLI" tag="CLI">
            <p>
              <Code>~/.gemini/settings.json</Code>
              （プロジェクト単位なら <Code>.gemini/settings.json</Code>）の{" "}
              <Code>mcpServers</Code> に追記:
            </p>
            <CodeBlock code={geminiCliJson} />
            <p>
              Gemini CLI を再起動し、<Code>/mcp</Code> で接続を確認します。
            </p>
          </ClientSection>

          <ClientSection title="Windsurf" tag="IDE">
            <p>
              <Code>~/.codeium/windsurf/mcp_config.json</Code> に追記
              （Settings → Cascade → MCP servers の「Edit raw config」からも開けます）:
            </p>
            <CodeBlock code={windsurfJson} />
          </ClientSection>

          <ClientSection title="Anthropic Messages API（MCP コネクタ）" tag="API">
            <p>
              Claude の API から直接 MCP サーバーを参照できます。
              <Code>anthropic-beta</Code> ヘッダーで MCP コネクタを有効化します。
            </p>
            <CodeBlock code={anthropicApi} />
            <Note>
              認証が有効な環境では、各 <Code>mcp_servers</Code> 要素に{" "}
              <Code>authorization_token</Code> でアクセストークンを渡します。
            </Note>
          </ClientSection>

          <ClientSection title="OpenAI Responses API" tag="API">
            <p>
              Responses API の <Code>tools</Code> に MCP サーバーを渡します。
            </p>
            <CodeBlock code={openaiApi} />
            <Note>
              認証が有効な環境では、<Code>headers</Code> フィールドに{" "}
              <Code>{'{"Authorization": "Bearer <token>"}'}</Code> を追加します。
            </Note>
          </ClientSection>

          <ClientSection title="Google Gemini API" tag="API">
            <p>
              <Code>google-genai</Code> SDK では、MCP の{" "}
              <Code>ClientSession</Code> をそのまま <Code>tools</Code>{" "}
              に渡せます。
            </p>
            <CodeBlock code={geminiApi} />
          </ClientSection>

          <ClientSection title="その他のクライアント" tag="共通">
            <p>
              Cline / Zed / JetBrains AI Assistant など、Streamable HTTP に対応した
              MCP クライアントであれば、設定の MCP サーバー登録欄に下記 URL を
              登録するだけで利用できます。トランスポートは「HTTP（Streamable HTTP）」
              を選択してください。
            </p>
            <UrlBox url={mcpUrl} />
          </ClientSection>
        </div>
      </section>
    </article>
  );
}

// --- ページ内ヘルパーコンポーネント -----------------------------------------

function Chevron({ className = "" }: { className?: string }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <path
        d="M4 2.5L7.5 6L4 9.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-indigo-800">
      {children}
    </code>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs leading-relaxed text-slate-500">
      {children}
    </p>
  );
}

function ToolItem({
  name,
  children,
}: {
  name: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
      <code className="shrink-0 font-mono text-[12px] text-indigo-800">
        {name}
      </code>
      <span className="text-slate-600">{children}</span>
    </li>
  );
}

function UrlBox({ url }: { url: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-slate-900 p-2.5">
      <code className="flex-1 break-all font-mono text-[13px] text-emerald-300">
        {url}
      </code>
      <CopyButton text={url} />
    </div>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md bg-slate-900 p-3 pr-20 text-xs leading-relaxed text-slate-100">
        <code className="font-mono">{code}</code>
      </pre>
      <div className="absolute right-2 top-2">
        <CopyButton text={code} />
      </div>
    </div>
  );
}

function ClientSection({
  title,
  tag,
  children,
}: {
  title: string;
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group/mcp rounded-lg border border-slate-200 bg-white">
      <summary className="flex cursor-pointer list-none select-none items-center gap-2 rounded-lg px-3 py-2.5 hover:bg-slate-50">
        <Chevron className="text-indigo-900 transition-transform group-open/mcp:rotate-90" />
        <span className="text-sm font-bold text-slate-900">{title}</span>
        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
          {tag}
        </span>
        <span className="ml-auto hidden text-[10px] text-slate-400 sm:inline">
          確認日 {LAST_UPDATED}
        </span>
      </summary>
      <div className="space-y-3 border-t border-slate-100 px-4 py-3 text-sm leading-relaxed text-slate-700">
        {children}
      </div>
    </details>
  );
}
