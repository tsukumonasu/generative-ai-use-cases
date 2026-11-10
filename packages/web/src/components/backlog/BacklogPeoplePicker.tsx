import React, { useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BacklogMember } from 'generative-ai-use-cases';
import { PiSpinnerGap, PiUserPlus, PiX } from 'react-icons/pi';
import {
  GanttPerson,
  MAX_GANTT_PEOPLE,
  memberMatches,
} from '../../utils/backlogGantt';

type Props = {
  // undefined while loading
  members?: BacklogMember[];
  membersFailed?: boolean;
  myselfId?: number;
  people: GanttPerson[];
  onAdd: (person: GanttPerson) => void;
  onRemove: (id: number) => void;
};

// Suggestions shown at once (the list scrolls)
const MAX_SUGGESTIONS = 50;

// Whom the Backlog gantt chart shows. People are found by name,
// login ID or email among the members of the user's projects, added one by
// one as chips, and removed with the chip's button.
const BacklogPeoplePicker: React.FC<Props> = ({
  members,
  membersFailed,
  myselfId,
  people,
  onAdd,
  onRemove,
}) => {
  const { t } = useTranslation();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [keyword, setKeyword] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const full = people.length >= MAX_GANTT_PEOPLE;
  const suggestions = useMemo(() => {
    const chosen = new Set(people.map((person) => person.id));
    return (members ?? [])
      .filter(
        (member) => !chosen.has(member.id) && memberMatches(member, keyword)
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [members, people, keyword]);

  const add = (member: BacklogMember) => {
    onAdd({ id: member.id, name: member.name });
    setKeyword('');
    setActive(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) {
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const member = suggestions[active];
      if (open && member) {
        add(member);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && !full && members !== undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`${listId}-input`} className="text-xs text-gray-500">
        {t('backlog.page.gantt.people')}
      </label>
      <div className="relative">
        <div
          className="flex min-h-[38px] flex-wrap items-center gap-1 rounded border border-black/30 bg-white px-2 py-1"
          onClick={() => inputRef.current?.focus()}>
          {people.map((person) => (
            <span
              key={person.id}
              className="bg-aws-smile/10 flex items-center gap-1 rounded-full py-0.5 pl-2.5 pr-1 text-sm">
              {person.id === myselfId
                ? t('backlog.page.gantt.person_myself', { name: person.name })
                : person.name}
              <button
                type="button"
                className="rounded-full p-0.5 text-gray-500 hover:bg-gray-200 hover:text-gray-800"
                aria-label={t('backlog.page.gantt.remove', {
                  name: person.name,
                })}
                title={t('backlog.page.gantt.remove', { name: person.name })}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(person.id);
                }}>
                <PiX className="text-xs" />
              </button>
            </span>
          ))}
          <span className="flex min-w-48 grow items-center gap-1 text-gray-400">
            {members === undefined && !membersFailed ? (
              <PiSpinnerGap className="shrink-0 animate-spin" />
            ) : (
              <PiUserPlus className="shrink-0" />
            )}
            <input
              ref={inputRef}
              id={`${listId}-input`}
              role="combobox"
              aria-expanded={showList}
              aria-controls={listId}
              aria-autocomplete="list"
              className="min-w-0 grow border-none bg-transparent p-1 text-sm text-gray-800 focus:ring-0"
              placeholder={
                full
                  ? t('backlog.page.gantt.people_limit', {
                      n: MAX_GANTT_PEOPLE,
                    })
                  : t('backlog.page.gantt.people_placeholder')
              }
              value={keyword}
              disabled={full}
              onChange={(e) => {
                setKeyword(e.target.value);
                setActive(0);
                setOpen(true);
              }}
              onFocus={() => setOpen(true)}
              onBlur={() => setOpen(false)}
              onKeyDown={onKeyDown}
            />
          </span>
        </div>
        {showList && (
          <ul
            id={listId}
            role="listbox"
            className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-y-auto rounded border bg-white py-1 shadow-lg">
            {suggestions.length === 0 ? (
              <li className="px-3 py-2 text-sm text-gray-500">
                {t('backlog.page.gantt.no_match')}
              </li>
            ) : (
              suggestions.map((member, index) => (
                <li
                  key={member.id}
                  role="option"
                  aria-selected={index === active}
                  className={`cursor-pointer px-3 py-1.5 ${
                    index === active ? 'bg-gray-100' : ''
                  }`}
                  // Before the input's blur closes the list
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add(member);
                  }}
                  onMouseEnter={() => setActive(index)}>
                  <div className="text-sm">
                    {member.id === myselfId
                      ? t('backlog.page.gantt.person_myself', {
                          name: member.name,
                        })
                      : member.name}
                  </div>
                  <div className="flex gap-3 text-xs text-gray-500">
                    <span className="truncate">
                      {member.mailAddress || member.userId}
                    </span>
                    <span className="shrink-0">
                      {member.projectKeys.join(', ')}
                    </span>
                  </div>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {membersFailed && (
        <p className="text-xs text-red-600">
          {t('backlog.page.gantt.members_failed')}
        </p>
      )}
    </div>
  );
};

export default BacklogPeoplePicker;
