import { Button } from "@mistralai/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@mistralai/ui/dropdown-menu";
import { Link } from "@tanstack/react-router";
import {
  ArrowCounterClockwiseIcon,
  GridFourIcon,
  PlusIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { useRef } from "react";

import { useChatSideApps } from "../side-apps";

const CONTENT_CLASS = "bg-card text-subtle min-w-56 rounded-xl p-1.5";
const ITEM_CLASS = "focus:bg-state-ghost-hover focus:text-default gap-3 rounded-lg px-3 py-2";
const SUB_TRIGGER_CLASS =
  "focus:bg-state-ghost-hover focus:text-default data-[state=open]:bg-state-ghost-hover data-[state=open]:text-default gap-3 rounded-lg px-3 py-2";
const SEPARATOR_CLASS = "bg-[var(--border-default)]";

type ChatPlusMenuProps = {
  onReset: () => void;
  disabled?: boolean;
};

export function ChatPlusMenu({ onReset, disabled = false }: ChatPlusMenuProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Radix hands focus back to the trigger when the menu closes, and the browser scores that
  // programmatic focus as `:focus-visible` — so dismissing a mouse-opened menu with the mouse
  // left a focus ring on a user who never touched the keyboard. Returning focus is right for
  // keyboard users though, so the pointer case is suppressed rather than the behaviour removed.
  const closedByPointer = useRef(false);
  const sideApps = useChatSideApps();

  return (
    <>
      <DropdownMenu onOpenChange={(open) => open && (closedByPointer.current = false)}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            mode="icon-only"
            icon={<PlusIcon className="size-4" />}
            aria-label="Add"
            isDisabled={disabled}
            className="shrink-0"
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className={CONTENT_CLASS}
          onPointerDownOutside={() => {
            closedByPointer.current = true;
          }}
          onCloseAutoFocus={(event) => {
            if (closedByPointer.current) {
              event.preventDefault();
            }
          }}
        >
          <DropdownMenuItem className={ITEM_CLASS} onSelect={() => fileInputRef.current?.click()}>
            <UploadSimpleIcon />
            Upload Files
          </DropdownMenuItem>

          {/* Every side app installed under the chat layout; the entry is gone when there is none. */}
          {sideApps.length > 0 ? (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className={SUB_TRIGGER_CLASS}>
                <GridFourIcon />
                Apps
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className={CONTENT_CLASS}>
                {sideApps.map((app) => {
                  const Icon = app.icon;
                  return (
                    <DropdownMenuItem key={app.id} asChild className={ITEM_CLASS}>
                      {/* `search` kept, not replaced: opening a side app must not drop the thread. */}
                      <Link to={app.path} search={true}>
                        <Icon className="size-4" />
                        {app.label}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          ) : null}

          <DropdownMenuSeparator className={SEPARATOR_CLASS} />

          <DropdownMenuItem className={ITEM_CLASS} onSelect={onReset}>
            <ArrowCounterClockwiseIcon />
            Reset input
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          event.currentTarget.value = "";
        }}
      />
    </>
  );
}
