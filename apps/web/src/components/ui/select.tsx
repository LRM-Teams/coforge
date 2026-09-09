// Adapted from Untitled UI React's base/select/{select,select-item,popover}.tsx (MIT).
import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import {
  Button,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue as AriaSelectValue,
  Text,
} from "react-aria-components";
import { Check, ChevronDown } from "@untitledui/icons";
import { cn } from "@/lib/utils";

function Select({
  value,
  onValueChange,
  disabled,
  required,
  name,
  children,
  ...props
}: Omit<ComponentProps<typeof AriaSelect>, "value" | "onChange"> & {
  value: string | null;
  onValueChange: (value: string | null) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const childNodes = typeof children === "function" ? [] : Children.toArray(children);
  const trigger = childNodes.find(
    (child) => isValidElement<{ "aria-label"?: string }>(child) && child.type === SelectTrigger,
  );
  const ariaLabel =
    props["aria-label"] ??
    (isValidElement<{ "aria-label"?: string }>(trigger) ? trigger.props["aria-label"] : undefined);
  return (
    <>
      <AriaSelect
        {...props}
        aria-label={ariaLabel}
        className="min-w-0"
        selectedKey={value === null ? null : encodeValue(value)}
        onSelectionChange={(key) => onValueChange(key === null ? null : decodeValue(String(key)))}
        isDisabled={disabled}
        isRequired={required}
      >
        {children}
      </AriaSelect>
      {name && <input type="hidden" name={name} value={value ?? ""} disabled={disabled} />}
    </>
  );
}

function encodeValue(value: string) {
  return `option-${Array.from(value, (character) => character.codePointAt(0)!.toString(16)).join("-")}`;
}

function decodeValue(value: string) {
  const encoded = value.slice("option-".length);
  return encoded
    ? encoded
        .split("-")
        .map((point) => String.fromCodePoint(Number.parseInt(point, 16)))
        .join("")
    : "";
}

function SelectTrigger({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "children" | "className"> & {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Button
      {...props}
      render={
        props["aria-label"]
          ? (domProps) => (
              <button
                {...domProps}
                aria-label={props["aria-label"]}
                aria-labelledby={props["aria-labelledby"]}
              />
            )
          : undefined
      }
      data-slot="select-trigger"
      className={cn(
        "relative flex h-10 w-full cursor-pointer items-center gap-2 rounded-lg bg-background px-3 text-left text-sm text-foreground shadow-xs ring-1 ring-border outline-none transition duration-100 ease-linear ring-inset data-focus-visible:ring-2 data-focus-visible:ring-ring data-pressed:ring-2 data-pressed:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
    >
      {children}
      <ChevronDown aria-hidden="true" className="ml-auto size-4 shrink-0 text-muted-foreground" />
    </Button>
  );
}

const SelectValue = AriaSelectValue;

function SelectContent({
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Popover>, "className" | "children"> & {
  className?: string;
  children: ReactNode;
}) {
  return (
    <Popover
      {...props}
      placement="bottom start"
      offset={4}
      className={cn(
        "z-50 max-h-80 w-(--trigger-width) min-w-48 overflow-auto rounded-lg bg-popover py-1 text-popover-foreground shadow-lg ring-1 ring-border outline-none",
        className,
      )}
    >
      <ListBox className="size-full outline-none">{children}</ListBox>
    </Popover>
  );
}

function SelectItem({
  value,
  className,
  children,
  disabled,
  ...props
}: Omit<ComponentProps<typeof ListBoxItem>, "value" | "className" | "children"> & {
  value: string;
  className?: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <ListBoxItem
      {...props}
      id={encodeValue(value)}
      isDisabled={disabled}
      textValue={typeof children === "string" ? children : undefined}
      className={cn(
        "group mx-1 flex cursor-pointer items-center gap-2 rounded-md p-2 pr-2.5 text-sm outline-none select-none data-hovered:bg-muted data-focused:bg-muted data-selected:bg-muted data-focus-visible:ring-2 data-focus-visible:ring-ring data-focus-visible:ring-inset data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className,
      )}
    >
      {({ isSelected }) => (
        <>
          <Text slot="label" className="min-w-0 flex-1 font-medium">
            {children}
          </Text>
          {isSelected && (
            <Check aria-hidden="true" className="ml-auto size-4 shrink-0 text-brand" />
          )}
        </>
      )}
    </ListBoxItem>
  );
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue };
