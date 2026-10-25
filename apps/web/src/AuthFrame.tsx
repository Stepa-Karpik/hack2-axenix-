import type { ReactNode } from "react";
import { ArrowUpRight, Code2, GitBranch, Workflow } from "lucide-react";
import { ProductBrand } from "./Account";

export default function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <div className="product-page auth-page">
      <header className="product-header">
        <ProductBrand />
      </header>
      <main className="auth-layout">
        <section className="auth-form-panel" aria-label="Аккаунт">
          <div className="auth-form-wrap">{children}</div>
        </section>
        <section className="auth-story" aria-label="JavaBlueprints">
          <div className="eyebrow">КОД. СТРУКТУРА. РЕЗУЛЬТАТ.</div>
          <h1>
            Увидеть код.
            <br />
            Понять логику.
          </h1>
          <p>Java и блок-схемы в одном рабочем пространстве.</p>
          <div className="auth-composition" aria-hidden="true">
            <div className="composition-tab">
              <Code2 size={17} /> Main.java <span>Java 21</span>
            </div>
            <pre>
              <span>int</span> find(int[] values, int target) {"{"}
              <br />
              {"  "}
              <span>for</span> (int i = 0; i &lt; values.length; i++) {"{"}
              <br />
              {"    "}
              <span>if</span> (values[i] == target) return i;
              <br />
              {"  }"}
              <br />
              {"  "}
              <span>return</span> -1;
              <br />
              {"}"}
            </pre>
            <div className="composition-flow">
              <span>
                <Workflow size={18} /> Цикл
              </span>
              <i />
              <span>
                <GitBranch size={18} /> Условие
              </span>
              <i />
              <span>
                <ArrowUpRight size={18} /> Возврат
              </span>
            </div>
          </div>
          <small>Пишите. Исследуйте. Проверяйте.</small>
        </section>
      </main>
    </div>
  );
}
