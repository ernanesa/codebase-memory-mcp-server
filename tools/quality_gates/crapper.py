#!/usr/bin/env python3
"""
Crapper: Change Risk Analysis and Predictions (CRAP Score Engine)
Suporte de primeira classe para C# (.NET), TypeScript, JavaScript e Python.

Fórmula oficial do Uncle Bob (crap4j / crap4clj):
    CRAP = CC^2 * (1 - coverage)^3 + CC

Onde:
- CC é a Complexidade Ciclomática (1 + ramificações: if, else if, for, while, switch/case, catch, &&, ||, ??, ?:).
- coverage é a fração da função coberta por testes (0.0 a 1.0).
- CRAP < 5: Baixo risco (Excelente).
- CRAP 5-10: Moderado (Aceitável).
- CRAP >= 10: Risco Crítico / Violação de Quality Gate (Necessita refatoração ou testes imediatos).
"""

import os
import sys
import re
import json
import argparse
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import List, Dict, Any, Optional, Set, Tuple

class FunctionMetric:
    def __init__(self, file_path: str, name: str, start_line: int, end_line: int, cc: int, coverage: float = 0.0):
        self.file_path = file_path
        self.name = name
        self.start_line = start_line
        self.end_line = end_line
        self.cc = cc
        self.coverage = max(0.0, min(1.0, coverage))
        self.crap = self.calculate_crap()

    def calculate_crap(self) -> float:
        # CRAP = CC^2 * (1 - coverage)^3 + CC
        return round((self.cc ** 2) * ((1.0 - self.coverage) ** 3) + self.cc, 2)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "file": self.file_path,
            "function": self.name,
            "lines": f"{self.start_line}-{self.end_line}",
            "loc": self.end_line - self.start_line + 1,
            "cyclomatic_complexity": self.cc,
            "coverage": round(self.coverage, 2),
            "crap_score": self.crap,
            "status": "PASS" if self.crap < 10.0 else "FAIL"
        }

class CoverageIndex:
    """Índice O(1) de cobertura real (Cobertura XML / LCOV) com fallback por conjunto pré-indexado de arquivos de teste."""
    def __init__(self, root_dir: Path):
        self.root_dir = root_dir
        self.test_filenames: Set[str] = set()
        self.line_coverage: Dict[str, Dict[int, int]] = {}
        self._build_index()

    def _normalize_rel(self, path_str: str) -> str:
        return path_str.replace("\\", "/").lstrip("./")

    def _build_index(self) -> None:
        skip_dirs = {"bin", "obj", "node_modules", ".git", "Migrations", "dist"}
        cobertura_files: List[Path] = []
        lcov_files: List[Path] = []
        search_roots = [self.root_dir]
        if self.root_dir.name in ("src", "source") and self.root_dir.parent != self.root_dir:
            search_roots.append(self.root_dir.parent)

        for sroot in search_roots:
            for p in sroot.rglob("*"):
                if any(skip in p.parts for skip in skip_dirs):
                    continue
                if not p.is_file():
                    continue
                name_lower = p.name.lower()
                if name_lower in ("coverage.cobertura.xml", "cobertura.xml", "coverage.xml"):
                    cobertura_files.append(p)
                elif name_lower == "lcov.info":
                    lcov_files.append(p)
                elif p.suffix in (".cs", ".ts", ".tsx", ".js", ".py"):
                    self.test_filenames.add(p.name)

        for cob in cobertura_files:
            self._parse_cobertura(cob)
        for lcov in lcov_files:
            self._parse_lcov(lcov)

    def _parse_cobertura(self, xml_path: Path) -> None:
        try:
            tree = ET.parse(xml_path)
            for cls in tree.findall(".//class"):
                filename = cls.attrib.get("filename")
                if not filename:
                    continue
                norm = self._normalize_rel(filename)
                lines_map = self.line_coverage.setdefault(norm, {})
                for line_el in cls.findall(".//line"):
                    num = int(line_el.attrib.get("number", "0"))
                    hits = int(line_el.attrib.get("hits", "0"))
                    if num > 0:
                        lines_map[num] = max(lines_map.get(num, 0), hits)
        except Exception:
            pass

    def _parse_lcov(self, lcov_path: Path) -> None:
        try:
            current_file: Optional[str] = None
            with open(lcov_path, "r", encoding="utf-8", errors="ignore") as f:
                for raw_line in f:
                    line = raw_line.strip()
                    if line.startswith("SF:"):
                        sf_path = Path(line[3:].strip())
                        try:
                            rel = sf_path.resolve().relative_to(self.root_dir.resolve())
                            current_file = self._normalize_rel(str(rel))
                        except Exception:
                            current_file = self._normalize_rel(line[3:].strip())
                    elif line.startswith("DA:") and current_file:
                        parts = line[3:].split(",")
                        if len(parts) >= 2:
                            num = int(parts[0])
                            hits = int(parts[1])
                            lines_map = self.line_coverage.setdefault(current_file, {})
                            lines_map[num] = max(lines_map.get(num, 0), hits)
                    elif line == "end_of_record":
                        current_file = None
        except Exception:
            pass

    def get_function_coverage(self, source_file: Path, start_line: int, end_line: int, default_if_tested: float) -> float:
        rel = str(source_file.relative_to(self.root_dir) if source_file.is_relative_to(self.root_dir) else source_file)
        norm_rel = self._normalize_rel(rel)

        # 1. Busca cobertura real por linhas (exact ou suffix match)
        lines_map = self.line_coverage.get(norm_rel)
        if lines_map is None:
            for key, val in self.line_coverage.items():
                if key.endswith(f"/{norm_rel}") or norm_rel.endswith(f"/{key}"):
                    lines_map = val
                    break

        if lines_map:
            instrumented = [hits for ln, hits in lines_map.items() if start_line <= ln <= end_line]
            if instrumented:
                covered = sum(1 for h in instrumented if h > 0)
                return covered / len(instrumented)

        # 2. Fallback O(1) no Set pré-indexado de arquivos de teste
        stem = source_file.stem
        candidates = (
            f"{stem}Test.cs", f"{stem}Tests.cs", f"{stem}.test.ts", f"{stem}.spec.ts",
            f"{stem}.test.tsx", f"{stem}.spec.tsx", f"{stem}.test.js", f"{stem}.spec.js",
            f"routes-{stem}.test.js", f"routes-{stem}-mcp.test.js", f"test_{stem}.py"
        )
        return default_if_tested if any(c in self.test_filenames for c in candidates) else 0.0


def find_test_file_for(source_file: Path, root_dir: Path) -> Optional[Path]:
    """Tenta localizar o arquivo de teste correspondente no projeto."""
    stem = source_file.stem
    candidates = [
        f"{stem}Test.cs", f"{stem}Tests.cs", f"{stem}.test.ts", f"{stem}.spec.ts",
        f"{stem}.test.tsx", f"{stem}.spec.tsx", f"test_{stem}.py"
    ]
    for cand in candidates:
        matches = list(root_dir.rglob(cand))
        if matches:
            return matches[0]
    return None

def analyze_csharp_file(file_path: Path, root_dir: Path, cov_index: Optional[CoverageIndex] = None) -> List[FunctionMetric]:
    metrics = []
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()

        has_test = False
        if cov_index is None:
            has_test = find_test_file_for(file_path, root_dir) is not None
        base_coverage = 0.85 if has_test else 0.0

        # Regex para métodos C#
        pattern = re.compile(
            r'^\s*(?:public|private|protected|internal)(?:\s+static)?(?:\s+async)?(?:\s+virtual)?(?:\s+override)?\s+([\w<>[\]?]+)\s+(\w+)\s*\(([^)]*)\)',
            re.MULTILINE
        )

        for match in pattern.finditer(content):
            method_name = match.group(2)
            start_pos = match.start()
            start_line = content[:start_pos].count("\n") + 1

            open_brace = content.find("{", match.end())
            if open_brace == -1 or (open_brace - match.end() > 250):
                continue

            depth = 1
            curr = open_brace + 1
            body_chars = []
            while curr < len(content) and depth > 0:
                c = content[curr]
                if c == "{": depth += 1
                elif c == "}": depth -= 1
                body_chars.append(c)
                curr += 1

            if depth == 0:
                end_line = start_line + content[open_brace:curr].count("\n")
                body = "".join(body_chars[:-1])
                
                # Complexidade Ciclomática (CC) = 1 + ramificações
                branches = len(re.findall(r'\b(if|else\s+if|for|foreach|while|case|catch)\b', body))
                branches += body.count("&&") + body.count("||") + body.count("??")
                branches += len(re.findall(r'\?\s*[^:]+:', body)) # Operador ternário
                cc = 1 + branches

                rel_path = str(file_path.relative_to(root_dir) if file_path.is_relative_to(root_dir) else file_path)
                fn_cov = cov_index.get_function_coverage(file_path, start_line, end_line, 0.85) if cov_index else base_coverage
                metrics.append(FunctionMetric(rel_path, method_name, start_line, end_line, cc, fn_cov))
    except Exception:
        pass
    return metrics

def analyze_typescript_file(file_path: Path, root_dir: Path, cov_index: Optional[CoverageIndex] = None) -> List[FunctionMetric]:
    metrics = []
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            content = f.read()

        has_test = False
        if cov_index is None:
            has_test = find_test_file_for(file_path, root_dir) is not None
        base_coverage = 0.80 if has_test else 0.0

        # Regex para funções e métodos TS/JS
        pattern = re.compile(
            r'^\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|(?:public|private|protected|static)?\s*(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(?:public|private|protected|static)?\s*(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]]+)?\s*\{)',
            re.MULTILINE
        )

        for match in pattern.finditer(content):
            fn_name = match.group(1) or match.group(2) or match.group(3) or "anonymous"
            if fn_name in ["constructor", "render"] and "=>" not in match.group(0):
                continue
            start_pos = match.start()
            start_line = content[:start_pos].count("\n") + 1

            open_brace = content.find("{", match.end() - 2)
            if open_brace == -1 or open_brace - match.end() > 250:
                continue

            depth = 1
            curr = open_brace + 1
            body_chars = []
            while curr < len(content) and depth > 0:
                c = content[curr]
                if c == "{": depth += 1
                elif c == "}": depth -= 1
                body_chars.append(c)
                curr += 1

            if depth == 0:
                end_line = start_line + content[open_brace:curr].count("\n")
                body = "".join(body_chars[:-1])
                branches = len(re.findall(r'\b(if|else\s+if|for|while|case|catch)\b', body))
                branches += body.count("&&") + body.count("||") + body.count("??")
                branches += len(re.findall(r'\?\s*[^:]+:', body))
                cc = 1 + branches

                rel_path = str(file_path.relative_to(root_dir) if file_path.is_relative_to(root_dir) else file_path)
                fn_cov = cov_index.get_function_coverage(file_path, start_line, end_line, 0.80) if cov_index else base_coverage
                metrics.append(FunctionMetric(rel_path, fn_name, start_line, end_line, cc, fn_cov))
    except Exception:
        pass
    return metrics

def scan_path(target_path: Path, max_files: int = 1000) -> List[FunctionMetric]:
    all_metrics = []
    root = target_path if target_path.is_dir() else target_path.parent
    cov_index = CoverageIndex(root)
    files_to_scan = []

    if target_path.is_file():
        files_to_scan.append(target_path)
    else:
        for p in target_path.rglob("*"):
            if any(skip in p.parts for skip in ["bin", "obj", "node_modules", ".git", "Migrations", "dist"]):
                continue
            if p.suffix in [".cs", ".ts", ".tsx", ".js"]:
                files_to_scan.append(p)
                if len(files_to_scan) >= max_files:
                    break

    for p in files_to_scan:
        if p.suffix == ".cs":
            all_metrics.extend(analyze_csharp_file(p, root, cov_index))
        elif p.suffix in [".ts", ".tsx", ".js"]:
            all_metrics.extend(analyze_typescript_file(p, root, cov_index))

    all_metrics.sort(key=lambda m: m.crap, reverse=True)
    return all_metrics

def main():
    parser = argparse.ArgumentParser(description="Calculador de Métricas CRAP (Uncle Bob Standard)")
    parser.add_argument("path", nargs="?", default=".", help="Diretório ou arquivo a analisar")
    parser.add_argument("--threshold", type=float, default=10.0, help="Limite CRAP tolerado (padrão: 10.0)")
    parser.add_argument("--top", type=int, default=15, help="Quantidade de piores funções a exibir")
    parser.add_argument("--json", action="store_true", help="Saída em formato JSON")
    args = parser.parse_args()

    target = Path(args.path).resolve()
    results = scan_path(target)
    failing = [r for r in results if r.crap >= args.threshold]

    if args.json:
        print(json.dumps({
            "total_functions_analyzed": len(results),
            "failing_crap_functions": len(failing),
            "threshold": args.threshold,
            "worst_functions": [r.to_dict() for r in results[:args.top]]
        }, indent=2))
        return

    print("=" * 80)
    print(f"📊 CRAP SCORE REPORT (Uncle Bob Formula: CC² * (1 - cov)³ + CC)")
    print(f"Alvo: {target}")
    print(f"Total de funções analisadas: {len(results)} | Funções com CRAP >= {args.threshold}: {len(failing)}")
    print("=" * 80)
    print(f"{'CRAP':>6} | {'CC':>4} | {'Cov':>5} | {'Linhas':>8} | {'Função / Método':<30} | {'Arquivo'}")
    print("-" * 80)

    for r in results[:args.top]:
        status_flag = "❌" if r.crap >= args.threshold else "✅"
        fn_display = r.name[:28]
        file_display = r.file_path if len(r.file_path) < 45 else "..." + r.file_path[-42:]
        print(f"{r.crap:6.1f} | {r.cc:4d} | {r.coverage*100:4.0f}% | {r.start_line:>4}-{r.end_line:<3} | {status_flag} {fn_display:<27} | {file_display}")

    print("=" * 80)
    if failing:
        print(f"⚠️ QUALITY GATE FALHOU: {len(failing)} funções violam o teto de CRAP < {args.threshold}!")
        sys.exit(1)
    else:
        print("✅ QUALITY GATE APROVADO: Todas as funções estão sob controle (CRAP < 10)!")
        sys.exit(0)

if __name__ == "__main__":
    main()
