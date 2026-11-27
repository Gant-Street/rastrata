import { Pagination } from "@ark-ui/solid/pagination";
import { buttonAttrs } from "./button";
import { ChevronLeft, ChevronRight } from "./icons";
import { useUi } from "./locale";

export function Pager(props: {
  count: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const ui = useUi();
  const pages = () => Math.max(1, Math.ceil(props.count / props.pageSize));
  return (
    <Pagination.Root
      count={props.count}
      pageSize={props.pageSize}
      page={props.page}
      onPageChange={(detail) => props.onPageChange(detail.page)}
      translations={{ rootLabel: ui.messages.pager.label }}
      class="rt-row"
    >
      <Pagination.PrevTrigger
        {...buttonAttrs({ variant: "secondary", iconOnly: true })}
        aria-label={ui.messages.pager.previous}
      >
        <ChevronLeft class="rt-dir-icon" aria-hidden="true" />
      </Pagination.PrevTrigger>
      <span class="rt-description">{ui.messages.pager.position(props.page, pages())}</span>
      <Pagination.NextTrigger
        {...buttonAttrs({ variant: "secondary", iconOnly: true })}
        aria-label={ui.messages.pager.next}
      >
        <ChevronRight class="rt-dir-icon" aria-hidden="true" />
      </Pagination.NextTrigger>
    </Pagination.Root>
  );
}
