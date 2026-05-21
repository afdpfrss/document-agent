// 文書履歴ページ(/pr)は一旦非公開（404）。
// 再公開時はナビ項目(components/SiteNav.tsx)を戻し、実装は git 履歴から復元する。
import { notFound } from "next/navigation";

export default function PrListPage() {
  notFound();
}
