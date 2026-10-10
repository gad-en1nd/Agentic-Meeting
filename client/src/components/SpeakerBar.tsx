import { useI18n } from "../I18nProvider.tsx";
import { useEffect, useState } from "react";

import type { SpeakerInfo } from "../api.ts";
import { assignTargets } from "../selection.ts";
import { mergeTargets, nameSuggestions, renamableSpeakers } from "../sessionView.ts";

/** 把选中的发言归给谁：已有的说话人，或者新建一个（给名字）。 */
export type AssignTarget = { speakerIdx: number } | { newSpeaker: string };

interface Props {
  speakers: readonly SpeakerInfo[];
  members: readonly string[];
  onRename: (idx: number, displayName: string) => void;
  onMerge: (idx: number, into: number) => void;
  /** 字幕里选中了几条发言；大于 0 时这一排变成「点一下就归过去」 */
  selectedCount: number;
  onAssign: (target: AssignTarget) => void;
  onClearSelection: () => void;
}

/**
 * 说话人面板：本场出现过的说话人。
 * 平时点一个就能改名（配置里的成员名单作候选），或把他并到另一个人名下；
 * 字幕里选中了发言时，点一个就是把选中的发言归到他名下，末尾多一个「新说话人」。
 */
export function SpeakerBar({
  speakers,
  members,
  onRename,
  onMerge,
  selectedCount,
  onAssign,
  onClearSelection,
}: Props) {
  const { t } = useI18n();
  const [editing, setEditing] = useState<{ idx: number; name: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const assigning = selectedCount > 0;
  useEffect(() => {
    if (assigning) setEditing(null);
    else setAdding(null);
  }, [assigning]);

  if (assigning) {
    const commitNew = () => {
      const name = adding?.trim();
      setAdding(null);
      if (name) onAssign({ newSpeaker: name });
    };
    return (
      <div
        className="speakers speakers-assigning"
        role="group"
        aria-label={t("ui.speaker.assignGroup")}
      >
        <span className="speakers-label">{t("ui.speaker.selected", { count: selectedCount })}</span>
        {assignTargets(speakers).map((p) => (
          <button
            key={p.idx}
            type="button"
            className="chip chip-target"
            title={t("ui.speaker.assign", { count: selectedCount, name: p.display_name })}
            onClick={() => onAssign({ speakerIdx: p.idx })}
          >
            {p.display_name}
          </button>
        ))}
        {adding === null ? (
          <button
            type="button"
            className="chip chip-target chip-new"
            title={t("ui.speaker.newHelp")}
            onClick={() => setAdding("")}
          >
            {t("ui.speaker.new")}
          </button>
        ) : (
          <span
            className="chip chip-editing"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) setAdding(null);
            }}
          >
            <input
              aria-label={t("ui.speaker.newName")}
              placeholder={t("ui.speaker.placeholder")}
              list="speaker-names"
              value={adding}
              maxLength={50}
              autoFocus
              onChange={(event) => setAdding(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitNew();
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setAdding(null);
                }
              }}
            />
            <datalist id="speaker-names">
              {nameSuggestions(members, speakers, null).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <MemberChoices
              names={nameSuggestions(members, speakers, null)}
              label={(name) => t("ui.speaker.newMember", { name })}
              onPick={(name) => {
                setAdding(null);
                onAssign({ newSpeaker: name });
              }}
            />
          </span>
        )}
        <button type="button" className="link" onClick={onClearSelection}>
          {t("ui.selection.clear")}
        </button>
      </div>
    );
  }

  const people = renamableSpeakers(speakers);
  if (people.length === 0) return null;

  const commit = () => {
    if (editing) {
      const current = people.find((p) => p.idx === editing.idx);
      const name = editing.name.trim();
      if (name && name !== current?.display_name) onRename(editing.idx, name);
    }
    setEditing(null);
  };

  return (
    <div className="speakers" role="group" aria-label={t("ui.speaker.label")}>
      <span className="speakers-label">{t("ui.speaker.label")}</span>
      {people.map((p) =>
        editing?.idx === p.idx ? (
          <span
            key={p.idx}
            className="chip chip-editing"
            onBlur={(event) => {
              // 焦点还在这个小面板里（从输入框移到「合并到…」）就不收起
              if (!event.currentTarget.contains(event.relatedTarget)) commit();
            }}
          >
            <input
              aria-label={t("ui.speaker.rename", { name: p.display_name })}
              list="speaker-names"
              value={editing.name}
              maxLength={50}
              autoFocus
              onChange={(event) => setEditing({ idx: p.idx, name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                if (event.key === "Escape") setEditing(null);
              }}
            />
            <datalist id="speaker-names">
              {nameSuggestions(members, speakers, p.idx).map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <MemberChoices
              names={nameSuggestions(members, speakers, p.idx).filter((n) => n !== p.display_name)}
              label={(name) => t("ui.speaker.memberRename", { from: p.display_name, to: name })}
              onPick={(name) => {
                setEditing(null);
                onRename(p.idx, name);
              }}
            />
            {mergeTargets(speakers, p.idx).length > 0 && (
              <select
                aria-label={t("ui.speaker.merge", { name: p.display_name })}
                value=""
                onChange={(event) => {
                  const into = Number(event.target.value);
                  const target = speakers.find((s) => s.idx === into);
                  setEditing(null);
                  if (
                    target &&
                    window.confirm(
                      t("ui.speaker.mergeConfirm", {
                        from: p.display_name,
                        to: target.display_name,
                      }),
                    )
                  ) {
                    onMerge(p.idx, into);
                  }
                }}
              >
                <option value="">{t("ui.speaker.mergePlaceholder")}</option>
                {mergeTargets(speakers, p.idx).map((target) => (
                  <option key={target.idx} value={target.idx}>
                    {target.display_name}
                  </option>
                ))}
              </select>
            )}
          </span>
        ) : (
          <button
            key={p.idx}
            type="button"
            className="chip"
            title={t("ui.speaker.editHelp")}
            onClick={() => setEditing({ idx: p.idx, name: p.display_name })}
          >
            {p.display_name}
          </button>
        ),
      )}
    </div>
  );
}

/**
 * 成员名单里的候选，直接显示成按钮点一下就用。
 * 不能只靠 datalist：输入框里已经有当前名字，浏览器只列出包含这几个字的候选，名单看上去就是空的。
 */
function MemberChoices({
  names,
  label,
  onPick,
}: {
  names: readonly string[];
  label: (name: string) => string;
  onPick: (name: string) => void;
}) {
  const { t } = useI18n();
  if (names.length === 0) return null;
  return (
    <span className="member-choices" role="group" aria-label={t("ui.member.label")}>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          className="chip chip-member"
          title={label(name)}
          aria-label={label(name)}
          // 不抢输入框的焦点：Safari 点按钮不给按钮焦点，失焦会先把编辑框收起来，点击就落空了
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(name)}
        >
          {name}
        </button>
      ))}
    </span>
  );
}
