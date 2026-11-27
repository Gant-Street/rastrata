package tui

import (
	"fmt"
	"strings"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/charmbracelet/x/ansi"
)

const helpText = `Rastrata · manual bookkeeping

1 Accounts  2 Journal  3 Activity  4 Reports  5 Periods
Tab / Shift+Tab change area. ↑/↓ select. Enter inspects or opens a form.
r explicitly refreshes the book. ? opens this guide. q exits. Esc returns.
i shows the complete book/report scope. F2 shows the full last error.
o inspects a retained operation. u resumes its original bytes. Ctrl+c exits.

Accounts: n create, e rename/change, x close, f search.
Journal: v switches saved drafts / posted register, n creates a draft,
         d discards an editable draft with confirmation, x reverses a posted entry.
         [ / ] page the register or drafts. f filters posted reference/ID.
Reports: t cycles trial balance, profit & loss, balance sheet.
         d changes date/revision. Enter opens pinned account activity.
Activity: a chooses another account; f changes its date range;
          [ / ] pages; Enter opens the journal at the same population.
Periods: Enter prepares close/reopen; review the reason and effects before commit.

Forms: Tab / Shift+Tab change field. Ctrl+p opens a field/account picker.
       Ctrl+u clears before the caret. Enter advances, or submits on the last field.
Journal editor: Ctrl+g inspects the source event. Ctrl+n adds a line, Ctrl+d removes a line (minimum two).
                Ctrl+s saves only; Ctrl+Enter saves and requests a posting preview.
Review: Enter submits the exact plan. Esc returns to edit. Invalid plans cannot
        be committed from the TUI. Changed state requires a newly reviewed plan.
Rejected draft detail: r reopens the same draft at a new version after a durable
rejection. Review a new plan. Unresolved postings cannot be reopened.

Opening balances: create a dated journal with asset/liability amounts and an
explicit equity offset. The ordinary admission rules apply.

Canceling a pending request does not roll back a submitted operation. Its identity
remains visible. Inspect status or resume, using the same endpoint/book and request
journal. A retained commit takes precedence over its preparation on resume.

The local Bun service must run independently: bun run dev:api.
No hosted auth, plugins, banking or commercial document workflows are included.
The headless CLI is available for automation and alternative terminal presentation.`

// Ledger text is data, never terminal escape sequences. Control characters are
// removed before rendering labels and server diagnostics.
func safe(value string) string {
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, value)
}
func clip(value string, width int) string { return ansi.Truncate(safe(value), max(1, width), "…") }
func pad(value string, width int) string {
	value = clip(value, width)
	return value + strings.Repeat(" ", max(0, width-ansi.StringWidth(value)))
}
func (m *Model) title(value string) string {
	value = safe(value)
	if m.NoColor {
		return value
	}
	return lipgloss.NewStyle().Bold(true).Render(value)
}
func (m *Model) muted(value string) string {
	if m.NoColor {
		return value
	}
	return lipgloss.NewStyle().Faint(true).Render(value)
}
func (m *Model) selected(value string, selected bool) string {
	if selected {
		if m.NoColor {
			return "> " + value
		}
		return lipgloss.NewStyle().Bold(true).Render("> " + value)
	}
	return "  " + value
}
func (m *Model) rule() string { return m.muted(strings.Repeat("─", max(1, m.Width-2))) }
func (m *Model) View() tea.View {
	book, currency := "Unconfigured book", ""
	if m.Data.Book.Setup != nil {
		book = m.Data.Book.Setup.Name
		currency = m.Data.Book.Setup.Currency
	}
	header := []string{m.title("RASTRATA / LEDGER") + "   " + clip(book, max(12, m.Width-26)), clip(m.Client.BookID+" · "+currency+" · local development", m.Width-2)}
	names := []string{"Accounts", "Journal", "Activity", "Reports", "Periods"}
	tabs := []string{}
	for i, name := range names {
		value := fmt.Sprintf("%d %s", i+1, name)
		if i == m.Area {
			value = "[" + value + "]"
		}
		tabs = append(tabs, value)
	}
	if m.Width < 75 {
		tabs = []string{fmt.Sprintf("[%d %s] · 1–5 or Tab change area", m.Area+1, names[m.Area])}
	}
	header = append(header, strings.Join(tabs, "  "), m.rule())
	body := m.body()
	available := max(1, m.Height-len(header)-5)
	// Scroll long forms around focus. Tables manage their own selected-row window;
	// detail/review use a viewport so narrow terminals keep every monetary value.
	start := 0
	if m.Mode == "form" && m.Form != nil {
		line := m.Form.Focus*2 + 3
		if line >= available {
			start = max(0, line-available+2)
		}
	}
	if len(body) > available {
		body = body[min(start, len(body)-1):min(len(body), start+available)]
	}
	for len(body) < available {
		body = append(body, "")
	}
	notice := safe(m.Notice)
	if m.Busy {
		notice = "WAITING · Esc stops waiting; submitted writes may still complete."
	}
	footer := []string{m.rule(), clip(notice, m.Width-2), clip(m.shortcuts(), m.Width-2), clip(m.Client.Endpoint+" · operation "+m.LastOperationID, m.Width-2)}
	content := strings.Join(append(append(header, body...), footer...), "\n")
	view := tea.NewView(content)
	view.AltScreen = true
	view.WindowTitle = "Rastrata · " + safe(book)
	if m.Mode == "form" && m.Form != nil && !m.Busy {
		f := m.Form
		cursor := f.Fields[f.Focus].Input.Cursor()
		if cursor != nil {
			cursor.X += 4
			cursor.Y = len(header) + f.Focus*2 + 4 - start
			if cursor.Y >= len(header) && cursor.Y < len(header)+available {
				view.Cursor = cursor
			}
		}
	}
	return view
}
func (m *Model) shortcuts() string {
	if m.Width < 75 {
		switch m.Mode {
		case "form":
			return "Tab field · Ctrl+s save · F1 help · Esc"
		case "review":
			return "Enter commit · Esc edit · F1 help"
		case "picker":
			return "↑/↓ choose · Enter select · Esc back"
		case "detail", "help":
			return "↑/↓ scroll · Esc back · F1 help"
		default:
			return "1–5 area · Enter open · F1 help · q"
		}
	}
	switch m.Mode {
	case "form":
		if m.Form != nil && m.Form.Kind == "journal" {
			return "Tab field · Ctrl+p account · Ctrl+g source · Ctrl+n line · Ctrl+s save · Ctrl+Enter review · Esc back"
		}
		return "Tab field · Ctrl+p choices · Ctrl+Enter review/submit · Esc back"
	case "review":
		return "Enter commit reviewed plan · ↑/↓ scroll · Esc edit · o status · u resume"
	case "picker":
		return "Type to search · ↑/↓ select · Enter choose · Esc return"
	case "recovery":
		return "o inspect original identity · u resume original bytes · Esc return · q exit"
	case "leave", "discard":
		return "y confirm · n/Esc cancel"
	case "detail", "help":
		return "↑/↓ scroll · Esc return · x reverse journal · r recover rejected draft · o status · u resume"
	}
	switch m.Area {
	case 0:
		return "↑/↓ select · Enter detail · n create · e change · x close · f find · ? help · q exit"
	case 1:
		return "↑/↓ select · Enter open · v drafts/register · n new · d discard · x reverse · [/] page · ? help"
	case 2:
		return "Enter journal/account · a choose account · f range · [/] page · o status · ? help"
	case 3:
		return "t statement · d date/revision · Enter account activity · r refresh · ? help"
	case 4:
		return "Enter close/reopen · r refresh · o status · u resume · ? help · q exit"
	}
	return "? help · q exit"
}
func (m *Model) body() []string {
	switch m.Mode {
	case "form":
		return m.formContent()
	case "recovery":
		return []string{m.title("RESULT UNKNOWN"), "Operation " + m.LastOperationID, "The client stopped waiting. The server may have completed the write.", "o inspects its retained disposition; u resends its exact original request.", "No rollback is claimed. Keep the same endpoint, book and request journal."}
	case "review":
		return append([]string{m.title("REVIEW / " + m.Plan.Kind)}, strings.Split(m.Detail.View(), "\n")...)
	case "picker":
		return m.pickerContent()
	case "detail", "help":
		return append([]string{m.title(m.DetailTitle)}, strings.Split(m.Detail.View(), "\n")...)
	case "leave":
		return []string{m.title("Leave this editor?"), "The current unsaved edits will be discarded.", "A previously saved draft remains in the book.", "y leave · n keep editing"}
	case "discard":
		return []string{m.title("Discard selected draft?"), "Only an editable draft can be discarded.", "No posted accounting record is deleted.", "y discard · n cancel"}
	}
	if m.Data.Book.Setup == nil {
		return []string{"No configured book. r starts setup; q exits.", "The client connects to the independently running local API."}
	}
	switch m.Area {
	case 0:
		return m.accountTable()
	case 1:
		return m.journalTable()
	case 2:
		return m.activityTable()
	case 3:
		return m.reportTable()
	case 4:
		return m.periodTable()
	}
	return nil
}
func (m *Model) window(count, linesPerRow int) (int, int) {
	reserved := 4
	if m.Area == 2 && m.Data.Activity != nil {
		reserved = 7
	}
	if m.Area == 3 {
		reserved = 9
	}
	if m.Area == 4 {
		reserved = 9
	}
	rows := max(1, (m.Height-9-reserved)/linesPerRow)
	selected := m.Cursor[m.Area]
	start := max(0, selected-rows+1)
	return start, min(count, start+rows)
}
func (m *Model) accountTable() []string {
	accounts := m.accounts()
	lines := []string{m.title("CHART OF ACCOUNTS"), "Balance through fiscal year · configuration rev " + m.Data.Accounts.ConfigurationRevision, ""}
	start, end := m.window(len(accounts), 1)
	if m.Width < 80 {
		start, end = m.window(len(accounts), 3)
	} else {
		lines = append(lines, "  Code    Account                           Role          Balance    Status")
	}
	for i := start; i < end; i++ {
		a := accounts[i]
		status := "open"
		if a.ClosedOn != nil {
			status = "closed"
		}
		if m.Width < 80 {
			lines = append(lines, m.selected(a.Code+" · "+clip(a.Name, m.Width-16), i == m.Cursor[0]), "    "+a.Role+" · "+status, "    Balance "+a.Balance)
		} else {
			lines = append(lines, m.selected(pad(a.Code, 7)+" "+pad(a.Name, max(12, m.Width-54))+" "+pad(a.Role, 14)+fmt.Sprintf(" %20s  %s", a.Balance, status), i == m.Cursor[0]))
		}
	}
	if len(accounts) == 0 {
		lines = append(lines, "No matching accounts.")
	}
	if m.Width >= 115 && len(accounts) > 0 {
		account := accounts[min(m.Cursor[0], len(accounts)-1)]
		lines = append(lines, "", m.muted(clip(strings.ReplaceAll(m.accountContent(account), "\n", " · "), m.Width-2)))
	}
	return lines
}
func (m *Model) journalTable() []string {
	label, count, size := "POSTED REGISTER", m.Data.Journal.Count, m.Data.Journal.PageSize
	if m.Drafts {
		label, count, size = "SAVED DRAFTS", m.Data.Drafts.Count, m.Data.Drafts.PageSize
	}
	lines := []string{m.title(label), fmt.Sprintf("Page %d · %d records · %d per page · v changes view", m.Pages[1], count, size)}
	if !m.Drafts {
		lines = append(lines, "Pinned book revision "+m.Data.Journal.Scope.Revision)
	} else {
		lines = append(lines, "Drafts are unposted · editing uses the saved version")
	}
	lines = append(lines, "")
	n := len(m.Data.Journal.Entries)
	if m.Drafts {
		n = len(m.Data.Drafts.Drafts)
	}
	per := 1
	if m.Width < 80 {
		per = 3
	}
	start, end := m.window(n, per)
	for i := start; i < end; i++ {
		id, date, reference, status, amount := "", "", "", "", ""
		if m.Drafts {
			d := m.Data.Drafts.Drafts[i]
			id, date, reference, status = d.ID, d.Data.Date, d.Data.Reference, d.Status
			amount = fmt.Sprintf("version %d", d.Version)
		} else {
			e := m.Data.Journal.Entries[i]
			id, date, reference, status, amount = e.ID, e.Date, e.Reference, e.Status, e.Amount
		}
		if m.Width < 80 {
			lines = append(lines, m.selected(date+" · "+clip(reference, m.Width-19), i == m.Cursor[1]), "    "+status+" · "+amount, "    ID "+id)
		} else {
			lines = append(lines, m.selected(date+"  "+pad(reference, max(10, m.Width-65))+fmt.Sprintf(" %20s  ", amount)+pad(status, 8)+" "+clip(id, 14), i == m.Cursor[1]))
		}
	}
	if n == 0 {
		lines = append(lines, "No records on this page. n creates a journal draft.")
	}
	return lines
}
func (m *Model) activityTable() []string {
	a := m.Data.Activity
	if a == nil {
		return append([]string{m.title("CHOOSE AN ACCOUNT FOR ACTIVITY")}, m.accountTable()[1:]...)
	}
	lines := []string{m.title("ACCOUNT ACTIVITY / " + a.Account.Code + " · " + clip(a.Account.Name, m.Width-28)), "As of " + a.AsOf + " · " + a.Currency + " · " + a.Basis, "Revision " + a.Revision + " · population " + clip(a.PopulationHash, max(8, m.Width-35)), fmt.Sprintf("%s → %s · page %d", a.From, a.To, a.Page), "Opening " + a.OpeningBalance, "Closing " + a.ClosingBalance, ""}
	per := 1
	if m.Width < 95 {
		per = 4
	}
	start, end := m.window(len(a.Rows), per)
	for i := start; i < end; i++ {
		row := a.Rows[i]
		if m.Width < 95 {
			lines = append(lines, m.selected(row.Date+" · "+clip(row.Narration, m.Width-19), i == m.Cursor[2]), "    Dr "+row.Debit, "    Cr "+row.Credit, "    Running "+row.RunningBalance)
		} else {
			lines = append(lines, m.selected(row.Date+" "+pad(row.Narration, max(8, m.Width-80))+fmt.Sprintf(" %20s %20s %20s", row.Debit, row.Credit, row.RunningBalance), i == m.Cursor[2]))
		}
	}
	if len(a.Rows) == 0 {
		lines = append(lines, "No activity in this range at the selected population.")
	}
	return lines
}
func (m *Model) reportTable() []string {
	report := m.Data.Reports
	name := []string{"TRIAL BALANCE", "PROFIT & LOSS", "BALANCE SHEET"}[m.Statement]
	lines := []string{m.title(name), report.AsOf + " · " + report.Currency + " · " + report.Basis, "Revision " + report.BookRevision + " · population " + clip(report.PopulationHash, max(8, m.Width-35))}
	rows := m.reportRows()
	per := 1
	if m.Width < 80 {
		per = 2
		if m.Statement == 0 {
			per = 3
		}
	}
	start, end := m.window(len(rows), per)
	for i := start; i < end; i++ {
		row := rows[i]
		value := row.Amount
		if m.Statement == 0 {
			tb := report.TrialBalance.Rows[i]
			value = fmt.Sprintf("Dr %s  Cr %s", tb.Debit, tb.Credit)
		}
		if m.Width < 80 {
			lines = append(lines, m.selected(row.Code+" · "+clip(row.Name, m.Width-14), i == m.Cursor[3]))
			if m.Statement == 0 {
				tb := report.TrialBalance.Rows[i]
				lines = append(lines, "    Dr "+tb.Debit, "    Cr "+tb.Credit)
			} else {
				lines = append(lines, "    "+value)
			}
		} else {
			lines = append(lines, m.selected(pad(row.Code, 7)+" "+pad(row.Name, max(10, m.Width-62))+fmt.Sprintf(" %s", value), i == m.Cursor[3]))
		}
	}
	lines = append(lines, "")
	switch m.Statement {
	case 0:
		lines = append(lines, "TOTAL Dr "+report.TrialBalance.Debit, "TOTAL Cr "+report.TrialBalance.Credit, fmt.Sprintf("Balanced: %t", report.TrialBalance.Balanced))
	case 1:
		lines = append(lines, "Revenue "+report.ProfitAndLoss.Revenue, "Expenses "+report.ProfitAndLoss.Expenses, "NET INCOME "+report.ProfitAndLoss.NetIncome)
	case 2:
		lines = append(lines, "Assets "+report.BalanceSheet.Assets, "Liabilities "+report.BalanceSheet.Liabilities, "Equity incl. current earnings "+report.BalanceSheet.Equity, "Current earnings "+report.BalanceSheet.CurrentEarnings, fmt.Sprintf("Balanced: %t", report.BalanceSheet.Balanced))
	}
	return lines
}
func (m *Model) periodTable() []string {
	lines := []string{m.title("FISCAL PERIODS"), "Current book revision " + m.Data.Periods.BookRevision + " · Enter reviews close/reopen", ""}
	start, end := m.window(len(m.Data.Periods.Periods), 1)
	for i := start; i < end; i++ {
		p := m.Data.Periods.Periods[i]
		lines = append(lines, m.selected(pad(p.Label, 10)+" "+p.StartsOn+" → "+p.EndsOn+"  "+strings.ToUpper(p.Status), i == m.Cursor[4]))
	}
	if len(m.Data.Periods.Periods) > 0 {
		p := m.Data.Periods.Periods[min(m.Cursor[4], len(m.Data.Periods.Periods)-1)]
		lines = append(lines, "", p.ID)
		if p.ClosePackageID != nil {
			lines = append(lines, "Close package "+*p.ClosePackageID, "Report population "+*p.ReportPopulationHash, "Through revision "+*p.ClosingRevision)
		}
		for _, h := range m.Data.Periods.History {
			if h.PeriodID == p.ID {
				lines = append(lines, safe(h.Kind+" · "+h.Reason+" · revision "+h.BookRevision))
				break
			}
		}
	}
	return lines
}
func (m *Model) formContent() []string {
	f := m.Form
	if f == nil {
		return nil
	}
	lines := []string{m.title(f.Title)}
	identity := ""
	if f.Kind == "journal" {
		identity = "New unposted draft"
		if f.DraftID != "" {
			identity = fmt.Sprintf("Draft %s · version %d", f.DraftID, f.Version)
		}
	} else {
		identity = f.TargetID
	}
	lines = append(lines, safe(identity), "")
	for i, field := range f.Fields {
		marker := "  "
		if i == f.Focus {
			marker = "> "
		}
		lines = append(lines, marker+safe(field.Label), "    "+field.Input.View())
	}
	if f.Kind == "setup" {
		lines = append(lines, "", "Starting chart: 1000 Cash / 3000 Owner capital", "4000 Revenue / 5000 Expense. Zero opening balance.")
	}
	if f.Kind == "journal" {
		lines = append(lines, "", "Amounts use exact two-decimal strings. Each line selects an account ID.", "Ctrl+s saves; Ctrl+Enter requests the server's validation and posting preview.")
	}
	return lines
}
func (m *Model) pickerContent() []string {
	lines := []string{m.title("SELECT EXACT VALUE"), m.Picker.Search.View(), ""}
	choices := m.pickerChoices()
	rows := max(1, m.Height-15)
	start := max(0, m.Picker.Cursor-rows+1)
	for i := start; i < min(len(choices), start+rows); i++ {
		choice := choices[i]
		label := choice.Label + " [" + choice.ID + "]"
		if choice.Disabled {
			label += " · CLOSED"
		}
		lines = append(lines, m.selected(clip(label, m.Width-5), i == m.Picker.Cursor))
	}
	if len(choices) == 0 {
		lines = append(lines, "No matches. IDs are never chosen ambiguously.")
	}
	return lines
}
func (m *Model) planContent(plan api.PreparedOperation) string {
	lines := []string{fmt.Sprintf("Valid: %t · expected book revision %s", plan.Valid, plan.BookRevision), "Operation " + plan.PlanID, "Content hash " + plan.PlanHash, "", "Draft → REVIEW → durable receipt"}
	for _, problem := range plan.Problems {
		lines = append(lines, "INVALID / "+safe(problem.Code+": "+problem.Message))
	}
	for _, journal := range plan.Effects.Journals {
		lines = append(lines, "", journal.Date+" · "+safe(journal.Narration), "Journal "+journal.ID)
		for _, line := range journal.Lines {
			lines = append(lines, "  "+line.AccountID, "    Dr "+line.Debit+"  Cr "+line.Credit)
		}
	}
	for _, account := range plan.Effects.Accounts {
		closed := "open"
		if account.ClosedOn != nil {
			closed = "closed on " + *account.ClosedOn
		}
		lines = append(lines, "", account.ID+" · "+safe(account.Code+" · "+account.Name), closed)
	}
	for _, period := range plan.Effects.Periods {
		lines = append(lines, "", period.PeriodID+" · "+safe(period.Kind+" · "+period.Reason))
		if period.ClosePackageID != nil {
			lines = append(lines, "Close package "+*period.ClosePackageID)
		}
		if period.ReportPopulationHash != nil {
			lines = append(lines, "Report population "+*period.ReportPopulationHash)
		}
	}
	lines = append(lines, "", "This preview has no posted accounting effect.", "Enter submits exactly this plan; the server rechecks authority and state.")
	return strings.Join(lines, "\n")
}
func (m *Model) accountContent(a api.AccountRow) string {
	lines := []string{a.ID + " · " + safe(a.Code+" · "+a.Name), a.Role + " · opened " + a.OpenedOn, "Balance " + a.Balance}
	if a.ParentID != nil {
		lines = append(lines, "Parent "+*a.ParentID)
	}
	if a.ClosedOn != nil {
		lines = append(lines, "Closed on "+*a.ClosedOn)
	}
	return strings.Join(lines, "\n")
}
func (m *Model) entryContent(e api.JournalEntry) string {
	lines := []string{e.ID + " · " + e.Kind, e.Date + " · " + e.Currency, safe(e.Narration), "Recorded " + e.RecordedAt, "Posted at revision " + e.BookRevision + " · viewed at revision " + e.ViewedAtRevision, "Posting sequence " + e.PostingSequence, ""}
	if e.Correction != nil {
		lines = append(lines, "Correction "+e.Correction.Kind, "Original "+e.Correction.OriginalJournalID, "Correction "+e.Correction.CorrectionJournalID, "")
	}
	for _, line := range e.Lines {
		lines = append(lines, safe(line.Account), "  Dr "+line.Debit+"  Cr "+line.Credit)
	}
	return strings.Join(lines, "\n")
}
