package tui

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

const journalHeaderFields = 6

type Field struct {
	Label, Path string
	Input       textinput.Model
	Choices     []string
}
type Form struct {
	Kind, Title, TargetID string
	Fields                []Field
	Focus                 int
	DraftID               string
	Version               int
	Original              api.JournalDraftData
	Dirty                 bool
	ReviewAfterSave       bool
}

func field(label, path, value string, limit int, choices ...string) Field {
	input := textinput.New()
	input.Prompt = ""
	input.CharLimit = limit
	input.SetValue(safe(value))
	input.SetVirtualCursor(false)
	input.SetWidth(32)
	input.SetStyles(textinput.Styles{Cursor: textinput.CursorStyle{Shape: tea.CursorBar, Blink: false}})
	return Field{Label: label, Path: path, Input: input, Choices: choices}
}
func (f *Form) focus(index int) tea.Cmd {
	if len(f.Fields) == 0 {
		return nil
	}
	for i := range f.Fields {
		f.Fields[i].Input.Blur()
	}
	f.Focus = (index + len(f.Fields)) % len(f.Fields)
	return f.Fields[f.Focus].Input.Focus()
}
func (f *Form) value(index int) string { return f.Fields[index].Input.Value() }
func (f *Form) retainedSource() bool {
	return f.Kind == "journal" && f.DraftID != "" && f.Original.Source != nil && f.value(3) == f.Original.Source.ID
}
func (f *Form) sourceFieldReadOnly() bool {
	return f.retainedSource() && (f.Focus == 4 || f.Focus == 5)
}
func (f *Form) draftData() api.JournalDraftData {
	data := api.JournalDraftData{Date: f.value(0), Reference: f.value(1), Narration: f.value(2), Lines: []api.JournalLine{}}
	if f.retainedSource() {
		data.Source = f.Original.Source
	} else if f.value(3) != "" {
		data.Source = &api.SourceEvent{ID: f.value(3), Description: f.value(4)}
		if f.value(5) != "" {
			value := f.value(5)
			data.Source.EvidenceReference = &value
		}
	}
	for i := journalHeaderFields; i+2 < len(f.Fields); i += 3 {
		data.Lines = append(data.Lines, api.JournalLine{AccountID: f.value(i), Debit: f.value(i + 1), Credit: f.value(i + 2)})
	}
	return data
}
func (f *Form) unchanged() bool {
	a, _ := json.Marshal(f.draftData())
	b, _ := json.Marshal(f.Original)
	return string(a) == string(b)
}
func (f *Form) addLine(account, debit, credit string) {
	line := (len(f.Fields) - journalHeaderFields) / 3
	f.Fields = append(f.Fields, field(fmt.Sprintf("Line %d account", line+1), fmt.Sprintf("input.data.lines[%d].accountId", line), account, 128), field("Debit", fmt.Sprintf("input.data.lines[%d].debit", line), debit, 19), field("Credit", fmt.Sprintf("input.data.lines[%d].credit", line), credit, 19))
}
func (f *Form) removeLine(line int) {
	at := journalHeaderFields + line*3
	f.Fields = append(f.Fields[:at], f.Fields[at+3:]...)
	for i := journalHeaderFields; i+2 < len(f.Fields); i += 3 {
		index := (i - journalHeaderFields) / 3
		f.Fields[i].Label = fmt.Sprintf("Line %d account", index+1)
		for offset, name := range []string{"accountId", "debit", "credit"} {
			f.Fields[i+offset].Path = fmt.Sprintf("input.data.lines[%d].%s", index, name)
		}
	}
}
func journalForm(data api.JournalDraftData, id string, version int) *Form {
	f := &Form{Kind: "journal", Title: "Journal draft", DraftID: id, Version: version, Original: data, Fields: []Field{field("Accounting date", "input.data.date", data.Date, 10), field("Reference", "input.data.reference", data.Reference, 80), field("Narration", "input.data.narration", data.Narration, 1000)}}
	source := api.SourceEvent{}
	if data.Source != nil {
		source = *data.Source
	}
	evidence := ""
	if source.EvidenceReference != nil {
		evidence = *source.EvidenceReference
	}
	f.Fields = append(f.Fields, field("Source ID (optional)", "input.data.source.id", source.ID, 128), field("Source description", "input.data.source.description", source.Description, 1000), field("Evidence reference", "input.data.source.evidenceReference", evidence, 1000))
	for _, line := range data.Lines {
		f.addLine(line.AccountID, line.Debit, line.Credit)
	}
	f.focus(0)
	return f
}
func setupForm() *Form {
	year := strconv.Itoa(time.Now().Year())
	f := &Form{Kind: "setup", Title: "Create your local book", Fields: []Field{field("Book name", "input.name", "", 120), field("Currency", "input.currency", "USD", 3, "USD", "EUR", "GBP"), field("Fiscal year", "input.fiscalYear", year, 4), field("Periods", "input.periodModel", "monthly", 9, "monthly", "quarterly")}}
	f.focus(0)
	return f
}
func (m *Model) date() string {
	now := time.Now().Format("2006-01-02")
	if m.Data.Book.Setup == nil {
		return now
	}
	year := m.Data.Book.Setup.FiscalYear
	if strings.HasPrefix(now, strconv.Itoa(year)) {
		return now
	}
	return fmt.Sprintf("%d-01-15", year)
}
func (m *Model) newJournal(data *api.JournalDraftData) tea.Cmd {
	initial := api.JournalDraftData{Date: m.date(), Lines: []api.JournalLine{{}, {}}}
	if data != nil {
		initial = *data
	}
	m.Form = journalForm(initial, "", 0)
	m.Mode = "form"
	m.Notice = "Drafts change no posted balances. Ctrl+p selects an account."
	return m.Form.focus(0)
}
func (m *Model) accountForm(account *api.AccountRow, close bool) tea.Cmd {
	effective := m.Data.Accounts.SuggestedEffectiveOn
	if account == nil {
		m.Form = &Form{Kind: "account-create", Title: "Prepare a new account", Fields: []Field{field("Code", "input.code", "", 20), field("Name", "input.name", "", 120), field("Role", "input.role", "expense", 30, "asset", "liability", "equity", "income", "expense", "gain", "unrealizedGain"), field("Parent ID (optional)", "input.parentId", "", 128), field("Effective on", "input.effectiveOn", effective, 10)}}
	} else {
		m.Form = &Form{Kind: "account-change", Title: "Prepare account change", TargetID: account.ID, Fields: []Field{field("Name", "input.name", account.Name, 120), field("Close account", "input.close", strconv.FormatBool(close), 5, "false", "true"), field("Effective on", "input.effectiveOn", effective, 10)}}
	}
	m.Mode = "form"
	return m.Form.focus(0)
}
func (m *Model) reverseForm(id string) tea.Cmd {
	m.Form = &Form{Kind: "reverse", Title: "Prepare immutable reversal", TargetID: id, Fields: []Field{field("Accounting date", "input.accountingDate", m.date(), 10), field("Reason", "input.reason", "", 500)}}
	m.Mode = "form"
	return m.Form.focus(0)
}
func (m *Model) periodForm(period api.PeriodRow) tea.Cmd {
	operation := "close"
	if period.Status == "closed" {
		operation = "reopen"
	}
	m.Form = &Form{Kind: "period", Title: "Prepare period " + operation, TargetID: period.ID, Fields: []Field{field("Operation", "input.operation", operation, 10, "close", "reopen"), field("Reason", "input.reason", "", 500)}}
	m.Mode = "form"
	return m.Form.focus(1)
}
func (m *Model) statusForm() tea.Cmd {
	m.Form = &Form{Kind: "status", Title: "Inspect a durable operation", Fields: []Field{field("Operation ID", "input.operationId", m.LastOperationID, 128)}}
	m.Mode = "form"
	return m.Form.focus(0)
}
func (m *Model) dateForm() tea.Cmd {
	m.Form = &Form{Kind: "report-date", Title: "Report date and revision", Fields: []Field{field("As of", "input.asOf", m.AsOf, 10), field("Revision (blank = current)", "input.revision", "", 19)}}
	m.Mode = "form"
	return m.Form.focus(0)
}
func (m *Model) rangeForm() tea.Cmd {
	if m.Data.Activity == nil {
		return nil
	}
	m.Form = &Form{Kind: "activity-range", Title: "Filter pinned account activity", Fields: []Field{field("From", "input.from", m.Data.Activity.From, 10), field("Through", "input.to", m.Data.Activity.To, 10)}}
	m.Mode = "form"
	return m.Form.focus(0)
}
