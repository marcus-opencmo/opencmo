"use client";

/**
 * Vẽ câu trả lời của Assistant từ cây của `lib/markdown`. Chỉ phần tử React,
 * không `dangerouslySetInnerHTML`: chữ của model không bao giờ thành thẻ.
 */

import { useMemo } from "react";

import { parseMarkdown, type Block, type Inline, type List } from "@/lib/markdown";

function Inlines({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case "text":
            return <span key={index}>{node.text}</span>;
          case "strong":
            return (
              <strong key={index}>
                <Inlines nodes={node.children} />
              </strong>
            );
          case "em":
            return (
              <em key={index}>
                <Inlines nodes={node.children} />
              </em>
            );
          case "code":
            return <code key={index}>{node.text}</code>;
          case "link":
            return (
              <a key={index} href={node.href} target="_blank" rel="noopener noreferrer nofollow">
                <Inlines nodes={node.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function ListView({ list }: { list: List }) {
  const items = list.items.map((item, index) => (
    <li key={index}>
      <Inlines nodes={item.children} />
      {item.items ? <ListView list={item.items} /> : null}
    </li>
  ));
  return list.ordered ? <ol start={list.start}>{items}</ol> : <ul>{items}</ul>;
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case "heading": {
      const Tag = (["h3", "h4", "h5"] as const)[block.level - 1]!;
      return (
        <Tag>
          <Inlines nodes={block.children} />
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p>
          <Inlines nodes={block.children} />
        </p>
      );
    case "list":
      return <ListView list={block.list} />;
    case "quote":
      return (
        <blockquote>
          <Inlines nodes={block.children} />
        </blockquote>
      );
    case "code":
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
    case "rule":
      return <hr />;
  }
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={className ? `ed2-md ${className}` : "ed2-md"}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} />
      ))}
    </div>
  );
}
