package tui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"

	"charm.land/bubbles/v2/textinput"
	"charm.land/bubbles/v2/viewport"
	tea "charm.land/bubbletea/v2"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
	"github.com/charmbracelet/x/term"
)

type Snapshot struct {
	Book     api.BookContext
	Accounts api.AccountList
	Drafts   api.DraftPage
	Journal  api.JournalPage
	Reports  api.CoreReports
	Periods  api.PeriodList
	Activity *api.AccountActivity
}
type Result struct {
	Epoch int
	Kind  string
	Value any
	Err   error
}
type Picker struct {
	Search         textinput.Model
	Choices        []Choice
	Cursor, Target int
}
type Choice struct {
	ID, Label string
	Disabled  bool
}
type Model struct {
	Client                       *api.Client
	Context                      context.Context
	Width, Height, Area          int
	Mode                         string
	Data                         Snapshot
	AsOf                         string
	Revision                     *string
	Cursor                       [5]int
	Pages                        [5]int
	Drafts                       bool
	Statement                    int
	AccountSearch, JournalSearch string
	Form                         *Form
	Picker                       *Picker
	Plan                         *api.PreparedOperation
	Detail                       viewport.Model
	DetailTitle, DetailJournalID string
	BackMode, LastError          string
	Notice                       string
	Busy                         bool
	Epoch                        int
	Cancel                       context.CancelFunc
	LastOperationID              string
	DraftReadStatus              string
	DraftPostingOperationID      string
	ActiveWrite                  bool
	RecoverMode                  string
	NoColor                      bool
}

func NewModel(ctx context.Context, client *api.Client) *Model {
	m := &Model{Client: client, Context: ctx, Width: 100, Height: 30, Mode: "list", Drafts: true, NoColor: os.Getenv("NO_COLOR") != "", Pages: [5]int{1, 1, 1, 1, 1}}
	m.Detail = viewport.New()
	m.Detail.SoftWrap = true
	m.Detail.SetWidth(96)
	m.Detail.SetHeight(17)
	return m
}
func Run(ctx context.Context, client *api.Client) error {
	if !term.IsTerminal(os.Stdin.Fd()) || !term.IsTerminal(os.Stdout.Fd()) {
		return errors.New("tui requires an interactive terminal; use the headless commands for pipes")
	}
	_, err := tea.NewProgram(NewModel(ctx, client), tea.WithContext(ctx)).Run()
	return err
}
func (m *Model) Init() tea.Cmd { return m.reload() }
func (m *Model) task(kind, id string, work func(context.Context) (any, error)) tea.Cmd {
	if m.Cancel != nil {
		m.Cancel()
	}
	ctx, cancel := context.WithCancel(m.Context)
	m.Cancel = cancel
	m.Epoch++
	epoch := m.Epoch
	m.Busy = true
	m.ActiveWrite = id != ""
	if id != "" {
		m.LastOperationID = id
	}
	return func() tea.Msg {
		value, err := work(ctx)
		return Result{Epoch: epoch, Kind: kind, Value: value, Err: err}
	}
}
func (m *Model) reload() tea.Cmd {
	client, asOf, revision, pages, search := m.Client, m.AsOf, m.Revision, m.Pages, m.JournalSearch
	return m.task("reload", "", func(ctx context.Context) (any, error) {
		var data Snapshot
		var err error
		data.Book, err = client.BookGet(ctx, api.Empty{}, "")
		if err != nil {
			return nil, err
		}
		if data.Book.Setup == nil {
			return data, nil
		}
		if asOf == "" {
			asOf = fmt.Sprintf("%d-01-31", data.Book.Setup.FiscalYear)
		}
		if revision == nil && data.Book.Head != nil {
			value := data.Book.Head.BookRevision
			revision = &value
		}
		data.Accounts, err = client.AccountsList(ctx, api.Empty{}, "")
		if err != nil {
			return nil, err
		}
		page := pages[1]
		data.Drafts, err = client.DraftsList(ctx, api.PageInput{Page: &page}, "")
		if err != nil {
			return nil, err
		}
		query := api.JournalQuery{Page: &page, Revision: revision}
		status := "Posted"
		query.Status = &status
		if search != "" {
			query.Text = &search
		}
		data.Journal, err = client.JournalList(ctx, query, "")
		if err != nil {
			return nil, err
		}
		data.Reports, err = client.ReportsGet(ctx, api.ReportsInput{AsOf: asOf, Revision: revision}, "")
		if err != nil {
			return nil, err
		}
		data.Periods, err = client.PeriodsList(ctx, api.Empty{}, "")
		return data, err
	})
}
func (m *Model) prepareDraft() tea.Cmd {
	if m.Form == nil || m.Form.DraftID == "" {
		return nil
	}
	client, id, version := m.Client, m.Form.DraftID, m.Form.Version
	operation := api.NewOperationID()
	return m.task("plan", operation, func(ctx context.Context) (any, error) {
		return client.JournalPrepare(ctx, api.DraftVersionInput{DraftID: id, ExpectedVersion: version}, operation)
	})
}
func (m *Model) recoverDraft() tea.Cmd {
	if m.Form == nil || m.Form.Kind != "journal" || m.Form.DraftID == "" || m.DraftPostingOperationID == "" || (m.DraftReadStatus != "rejected" && m.DraftReadStatus != "posting") {
		return nil
	}
	client := m.Client
	input := api.DraftRecoveryInput{DraftID: m.Form.DraftID, ExpectedVersion: m.Form.Version, PostingOperationID: m.DraftPostingOperationID}
	operation := api.NewOperationID()
	return m.task("recovered", operation, func(ctx context.Context) (any, error) {
		return client.DraftsRecover(ctx, input, operation)
	})
}
func (m *Model) saveDraft(review bool) tea.Cmd {
	f := m.Form
	if f == nil {
		return nil
	}
	if f.DraftID != "" && f.unchanged() {
		if review {
			return m.prepareDraft()
		}
		m.Notice = "Draft is already saved."
		return nil
	}
	f.ReviewAfterSave = review
	client, id, version, data := m.Client, f.DraftID, f.Version, f.draftData()
	operation := api.NewOperationID()
	return m.task("saved", operation, func(ctx context.Context) (any, error) {
		if id == "" {
			return client.DraftsCreate(ctx, api.DraftCreateInput{Data: data}, operation)
		}
		return client.DraftsSave(ctx, api.DraftSaveInput{DraftID: id, ExpectedVersion: version, Data: data}, operation)
	})
}
func (m *Model) submitForm() tea.Cmd {
	f, client := m.Form, m.Client
	if f == nil {
		return nil
	}
	id := api.NewOperationID()
	switch f.Kind {
	case "journal":
		return m.saveDraft(true)
	case "setup":
		year, err := strconv.Atoi(f.value(2))
		if err != nil {
			m.Notice = "Fiscal year: enter a supported four-digit year."
			return nil
		}
		input := api.BookSetup{Name: f.value(0), Currency: f.value(1), FiscalYear: year, PeriodModel: f.value(3), Accounts: []api.InitialAccount{{Code: "1000", Name: "Cash", Role: "asset"}, {Code: "3000", Name: "Owner capital", Role: "equity"}, {Code: "4000", Name: "Revenue", Role: "income"}, {Code: "5000", Name: "Expense", Role: "expense"}}}
		return m.task("configured", id, func(ctx context.Context) (any, error) { return client.BookSetup(ctx, input, id) })
	case "account-create":
		input := api.AccountCreateInput{Code: f.value(0), Name: f.value(1), Role: f.value(2), EffectiveOn: f.value(4)}
		if f.value(3) != "" {
			parent := f.value(3)
			input.ParentID = &parent
		}
		return m.task("plan", id, func(ctx context.Context) (any, error) { return client.AccountsPrepareCreate(ctx, input, id) })
	case "account-change":
		close, err := strconv.ParseBool(f.value(1))
		if err != nil {
			m.Notice = "Close account: use true or false."
			return nil
		}
		input := api.AccountChangeInput{AccountID: f.TargetID, Name: f.value(0), Close: close, EffectiveOn: f.value(2)}
		return m.task("plan", id, func(ctx context.Context) (any, error) { return client.AccountsPrepareChange(ctx, input, id) })
	case "reverse":
		input := api.ReverseInput{JournalID: f.TargetID, AccountingDate: f.value(0), Reason: f.value(1)}
		return m.task("plan", id, func(ctx context.Context) (any, error) { return client.JournalPrepareReverse(ctx, input, id) })
	case "period":
		input := api.PeriodInput{PeriodID: f.TargetID, Operation: f.value(0), Reason: f.value(1)}
		return m.task("plan", id, func(ctx context.Context) (any, error) { return client.PeriodsPrepare(ctx, input, id) })
	case "status":
		operation := f.value(0)
		m.LastOperationID = operation
		return m.task("status", "", func(ctx context.Context) (any, error) {
			return client.OperationsGet(ctx, api.OperationInput{OperationID: operation}, "")
		})
	case "report-date":
		m.AsOf = f.value(0)
		m.Revision = nil
		if f.value(1) != "" {
			revision := f.value(1)
			m.Revision = &revision
		}
		m.Mode = "list"
		return m.reload()
	case "activity-range":
		if m.Data.Activity == nil {
			return nil
		}
		scope := *m.Data.Activity
		input := api.ActivityInput{AccountID: scope.Account.ID, AsOf: scope.AsOf, Revision: &scope.Revision, PopulationHash: &scope.PopulationHash, From: f.value(0), To: f.value(1)}
		m.Mode = "list"
		return m.task("activity", "", func(ctx context.Context) (any, error) { return client.ActivityGet(ctx, input, "") })
	case "search":
		m.JournalSearch = f.value(0)
		m.Pages[1] = 1
		m.Mode = "list"
		return m.reload()
	case "account-search":
		m.AccountSearch = f.value(0)
		m.Cursor[0] = 0
		m.Mode = "list"
		return nil
	}
	return nil
}
func (m *Model) commit() tea.Cmd {
	if m.Plan == nil {
		return nil
	}
	if !m.Plan.Valid {
		m.Notice = "This preparation is invalid. Correct the input and review a new plan."
		return nil
	}
	client, plan := m.Client, *m.Plan
	return m.task("receipt", plan.PlanID, func(ctx context.Context) (any, error) {
		return client.OperationsCommit(ctx, api.CommitInput{PlanID: plan.PlanID, PlanHash: plan.PlanHash}, plan.PlanID)
	})
}
func (m *Model) resume() tea.Cmd {
	client, id := m.Client, m.LastOperationID
	if id == "" {
		m.Notice = "Select an operation identity first."
		return nil
	}
	return m.task("resume", id, func(ctx context.Context) (any, error) { return client.Resume(ctx, id) })
}
func (m *Model) activity(accountID string, page int) tea.Cmd {
	client, report := m.Client, m.Data.Reports
	input := api.ActivityInput{AccountID: accountID, AsOf: report.AsOf, Revision: &report.BookRevision, PopulationHash: &report.PopulationHash, From: report.PeriodStart, To: report.AsOf, Page: &page}
	if m.Data.Activity != nil && m.Data.Activity.Account.ID == accountID {
		current := m.Data.Activity
		input.AsOf = current.AsOf
		input.Revision = &current.Revision
		input.PopulationHash = &current.PopulationHash
		input.From = current.From
		input.To = current.To
	}
	m.Area = 2
	m.Pages[2] = page
	return m.task("activity", "", func(ctx context.Context) (any, error) { return client.ActivityGet(ctx, input, "") })
}
func (m *Model) journal(id string, pinned bool) tea.Cmd {
	client := m.Client
	input := api.JournalGetInput{JournalID: id}
	if pinned && m.Data.Activity != nil {
		scope := m.Data.Activity
		input.Revision = &scope.Revision
		input.AsOf = &scope.AsOf
		input.PopulationHash = &scope.PopulationHash
	} else {
		revision := m.Data.Journal.Scope.Revision
		input.Revision = &revision
	}
	return m.task("entry", "", func(ctx context.Context) (any, error) { return client.JournalGet(ctx, input, "") })
}
func (m *Model) detail(title, content string) {
	m.BackMode = m.Mode
	m.Mode = "detail"
	m.DetailTitle = title
	m.DetailJournalID = ""
	m.Detail.SetContent(content)
	m.Detail.GotoTop()
}
func (m *Model) response(result Result) tea.Cmd {
	if result.Epoch != m.Epoch {
		return nil
	}
	m.Busy = false
	if m.Cancel != nil {
		m.Cancel()
		m.Cancel = nil
	}
	if result.Err != nil {
		m.Notice = result.Err.Error()
		var failure *api.Error
		if errors.As(result.Err, &failure) {
			if failure.OperationID() != "" {
				m.LastOperationID = failure.OperationID()
			}
			if failure.Response.Error != nil {
				for _, fieldError := range failure.Response.Error.Details {
					m.Notice += " · " + fieldError.Path + ": " + fieldError.Message
					if m.Form != nil {
						for i, field := range m.Form.Fields {
							if field.Path == fieldError.Path {
								m.Form.focus(i)
							}
						}
					}
				}
			}
		}
		m.LastError = m.Notice
		m.Notice = "ERROR · F2 shows full details · " + m.Notice
		return nil
	}
	switch result.Kind {
	case "reload":
		notice := m.Notice
		m.Data = result.Value.(Snapshot)
		if m.Data.Book.Setup == nil {
			m.Form = setupForm()
			m.Mode = "form"
			m.Notice = "Set up one local book. Review the starting chart before creating it."
			return m.Form.focus(0)
		}
		m.AsOf = m.Data.Reports.AsOf
		m.clamp()
		m.Notice = "Book loaded. Drafts and posted journals are separate."
		if strings.HasPrefix(notice, "COMMITTED") || strings.HasPrefix(notice, "REJECTED") {
			m.Notice = notice
		}
	case "configured":
		m.Mode = "list"
		m.Form = nil
		return m.reload()
	case "saved":
		draft := result.Value.(api.SavedDraft)
		review := m.Form != nil && m.Form.ReviewAfterSave
		focus := 0
		if m.Form != nil {
			focus = m.Form.Focus
		}
		m.Form = journalForm(draft.Data, draft.ID, draft.Version)
		m.Form.focus(min(focus, len(m.Form.Fields)-1))
		m.Notice = fmt.Sprintf("Draft saved · %s · version %d. Posted balances unchanged.", draft.ID, draft.Version)
		if review {
			return m.prepareDraft()
		}
		return m.Form.focus(m.Form.Focus)
	case "recovered":
		draft := result.Value.(api.SavedDraft)
		m.Form = journalForm(draft.Data, draft.ID, draft.Version)
		m.Plan = nil
		m.DraftReadStatus = "draft"
		m.DraftPostingOperationID = ""
		m.Mode = "form"
		m.Notice = fmt.Sprintf("Recovered draft · version %d. The rejected outcome remains; review a new plan before posting.", draft.Version)
		return m.Form.focus(0)
	case "plan":
		plan := result.Value.(api.PreparedOperation)
		m.Plan = &plan
		m.LastOperationID = plan.PlanID
		m.Mode = "review"
		m.Detail.SetContent(m.planContent(plan))
		m.Detail.GotoTop()
		m.Notice = "Review the exact effects. Enter commits this plan; Esc returns to the form."
	case "receipt":
		receipt := result.Value.(api.MutationReceipt)
		m.Mode = "list"
		m.Form = nil
		m.Plan = nil
		m.Notice = strings.ToUpper(receipt.Disposition) + " · operation " + receipt.OperationID
		if receipt.OutcomeSequence != nil {
			m.Notice += " · outcome " + *receipt.OutcomeSequence
		}
		for _, diagnostic := range receipt.Diagnostics {
			m.Notice += " · " + diagnostic
		}
		return m.reload()
	case "entry":
		entry := result.Value.(api.JournalEntry)
		m.detail("Posted journal", m.entryContent(entry))
		m.DetailJournalID = entry.ID
	case "activity":
		activity := result.Value.(api.AccountActivity)
		m.Data.Activity = &activity
		m.Area = 2
		m.Cursor[2] = 0
		m.Mode = "list"
		m.Notice = "Activity retains the report population. Enter opens its pinned journal."
	case "source":
		source := result.Value.(api.SourceRecord)
		m.detail("Source event", source.Source.ID+"\nStatus: "+source.Status+fmt.Sprintf("\nLinked drafts: %d (page %d)\n\n", source.Drafts.Count, source.Drafts.Page)+jsonText(mustJSON(source)))
	case "status":
		status := result.Value.(api.OperationStatus)
		raw, _ := json.MarshalIndent(status, "", "  ")
		m.detail("Operation status", string(raw)+"\n\nu resumes the original retained request; Esc returns.")
		m.Notice = "Status is the server's retained disposition."
	case "resume":
		response := result.Value.(api.Response)
		var plan api.PreparedOperation
		_ = json.Unmarshal(response.Data, &plan)
		if plan.Disposition == "prepared" {
			m.Plan = &plan
			m.Mode = "review"
			m.Detail.SetContent(m.planContent(plan))
			m.Detail.GotoTop()
			m.Notice = "Original preparation recovered. Review before commit."
			return nil
		}
		var receipt api.MutationReceipt
		_ = json.Unmarshal(response.Data, &receipt)
		if receipt.Disposition == "committed" || receipt.Disposition == "rejected" {
			return m.response(Result{Epoch: m.Epoch, Kind: "receipt", Value: receipt})
		}
		raw := jsonText(response.Data)
		// A completed application-only request must leave the uncertainty modal.
		// Refresh current drafts rather than treating its retained response as a
		// fresh snapshot that could overwrite later edits or revive a discard.
		m.Mode = "list"
		m.Form = nil
		m.Plan = nil
		m.DraftReadStatus = ""
		m.DraftPostingOperationID = ""
		m.detail("Recovered application result", raw)
		m.Notice = "Original request completed; refresh the book to inspect it."
		return m.reload()
	case "discarded":
		m.Mode = "list"
		m.Notice = "Draft discarded. Posted balances unchanged."
		return m.reload()
	}
	return nil
}
func (m *Model) Update(message tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := message.(type) {
	case Result:
		return m, m.response(msg)
	case tea.WindowSizeMsg:
		m.Width = msg.Width
		m.Height = msg.Height
		m.Detail.SetWidth(max(1, m.Width-4))
		m.Detail.SetHeight(max(1, m.Height-12))
		if m.Form != nil {
			for i := range m.Form.Fields {
				m.Form.Fields[i].Input.SetWidth(max(5, m.Width-8))
			}
		}
		return m, nil
	case tea.KeyPressMsg:
		key := msg.String()
		if key == "ctrl+c" {
			if m.Cancel != nil {
				m.Cancel()
			}
			return m, tea.Quit
		}
		if key == "f1" && !m.Busy {
			m.detail("Keyboard guide", helpText)
			m.Mode = "help"
			return m, nil
		}
		if key == "f2" && !m.Busy && m.LastError != "" {
			m.detail("Application error", safe(m.LastError))
			return m, nil
		}
		if m.Busy {
			if key == "esc" {
				if m.Cancel != nil {
					m.Cancel()
				}
				m.Epoch++
				m.Busy = false
				if m.ActiveWrite {
					m.RecoverMode = m.Mode
					m.Mode = "recovery"
					m.Notice = "Stopped waiting. The write may be unresolved; inspect or resume its original identity."
				} else {
					m.Notice = "Stopped waiting for a read. Refresh to retry."
				}
			}
			return m, nil
		}
		if m.Mode == "recovery" {
			switch key {
			case "o":
				return m, m.statusForm()
			case "u":
				return m, m.resume()
			case "esc":
				m.Mode = m.RecoverMode
			case "q":
				return m, tea.Quit
			}
			return m, nil
		}
		if m.Mode == "picker" {
			return m, m.pickerKey(msg)
		}
		if m.Mode == "form" {
			return m, m.formKey(msg)
		}
		if m.Mode == "review" {
			switch key {
			case "enter", "ctrl+enter":
				return m, m.commit()
			case "esc":
				m.Mode = "form"
				if m.Form == nil {
					m.Mode = "list"
				}
			case "o":
				return m, m.statusForm()
			case "u":
				return m, m.resume()
			}
			var scroll tea.Cmd
			m.Detail, scroll = m.Detail.Update(message)
			return m, scroll
		}
		if m.Mode == "leave" {
			if key == "y" {
				m.Mode = "list"
				m.Form = nil
				return m, m.reload()
			}
			if key == "n" || key == "esc" {
				m.Mode = "form"
			}
			return m, nil
		}
		if m.Mode == "discard" {
			if key == "y" {
				return m, m.discard()
			}
			if key == "n" || key == "esc" {
				m.Mode = "list"
			}
			return m, nil
		}
		if m.Mode == "detail" || m.Mode == "help" {
			switch key {
			case "esc":
				m.Mode = m.BackMode
				if m.Mode == "" || m.Mode == "detail" || m.Mode == "help" {
					m.Mode = "list"
				}
				return m, nil
			case "u":
				return m, m.resume()
			case "r":
				return m, m.recoverDraft()
			case "x":
				if m.DetailJournalID != "" {
					return m, m.reverseForm(m.DetailJournalID)
				}
			case "o":
				return m, m.statusForm()
			case "q":
				return m, tea.Quit
			}
			var cmd tea.Cmd
			m.Detail, cmd = m.Detail.Update(message)
			return m, cmd
		}
		switch key {
		case "q":
			return m, tea.Quit
		case "?":
			m.detail("Keyboard guide", helpText)
			m.Mode = "help"
		case "1", "2", "3", "4", "5":
			m.Area = int(key[0] - '1')
			m.Cursor[m.Area] = 0
		case "tab":
			m.Area = (m.Area + 1) % 5
		case "shift+tab":
			m.Area = (m.Area + 4) % 5
		case "up", "k":
			m.Cursor[m.Area] = max(0, m.Cursor[m.Area]-1)
		case "down", "j":
			m.Cursor[m.Area]++
			m.clamp()
		case "home":
			m.Cursor[m.Area] = 0
		case "end":
			m.Cursor[m.Area] = max(0, m.rowCount()-1)
		case "r":
			m.Revision = nil
			return m, m.reload()
		case "i":
			m.detail("Book and report scope", jsonText(mustJSON(m.Data.Book))+"\n\nReport scope\n"+jsonText(mustJSON(m.Data.Reports)))
			return m, nil
		case "o":
			return m, m.statusForm()
		case "u":
			return m, m.resume()
		case "v":
			if m.Area == 1 {
				m.Drafts = !m.Drafts
				m.Cursor[1] = 0
				m.Pages[1] = 1
				return m, m.reload()
			}
		case "t":
			if m.Area == 3 {
				m.Statement = (m.Statement + 1) % 3
				m.Cursor[3] = 0
			}
		case "[":
			return m, m.page(-1)
		case "]":
			return m, m.page(1)
		case "n":
			if m.Area == 0 {
				return m, m.accountForm(nil, false)
			}
			if m.Area == 1 {
				return m, m.newJournal(nil)
			}
		case "e":
			if m.Area == 0 {
				account := m.selectedAccount()
				if account != nil {
					return m, m.accountForm(account, false)
				}
			}
		case "x":
			if m.Area == 0 {
				account := m.selectedAccount()
				if account != nil {
					return m, m.accountForm(account, true)
				}
			}
			if m.Area == 1 && !m.Drafts && len(m.Data.Journal.Entries) > 0 {
				return m, m.reverseForm(m.Data.Journal.Entries[m.Cursor[1]].ID)
			}
		case "d":
			if m.Area == 1 && m.Drafts && len(m.Data.Drafts.Drafts) > 0 {
				m.Mode = "discard"
			}
			if m.Area == 3 {
				return m, m.dateForm()
			}
		case "f":
			if m.Area == 0 {
				m.Form = &Form{Kind: "account-search", Title: "Find an account", Fields: []Field{field("Code or name", "", m.AccountSearch, 200)}}
				m.Form.Kind = "account-search"
				m.Mode = "form"
				return m, m.Form.focus(0)
			}
			if m.Area == 1 {
				m.Form = &Form{Kind: "search", Title: "Filter posted register", Fields: []Field{field("Reference or ID", "input.text", m.JournalSearch, 200)}}
				m.Mode = "form"
				return m, m.Form.focus(0)
			}
			if m.Area == 2 {
				return m, m.rangeForm()
			}
		case "a":
			if m.Area == 2 {
				m.Data.Activity = nil
				m.Cursor[2] = 0
			}
		case "enter":
			return m, m.openSelected()
		}
	case tea.PasteMsg:
		if m.Mode == "form" && m.Form != nil {
			if m.Form.sourceFieldReadOnly() {
				m.Notice = "Original source facts are retained. Ctrl+g inspects the source."
				return m, nil
			}
			field := &m.Form.Fields[m.Form.Focus]
			var cmd tea.Cmd
			field.Input, cmd = field.Input.Update(tea.PasteMsg{Content: safe(msg.Content)})
			m.Form.Dirty = true
			return m, cmd
		}
		if m.Mode == "picker" && m.Picker != nil {
			var cmd tea.Cmd
			m.Picker.Search, cmd = m.Picker.Search.Update(tea.PasteMsg{Content: safe(msg.Content)})
			m.Picker.Cursor = 0
			return m, cmd
		}
	}
	if m.Mode == "form" && m.Form != nil {
		var cmd tea.Cmd
		field := &m.Form.Fields[m.Form.Focus]
		field.Input, cmd = field.Input.Update(message)
		return m, cmd
	}
	return m, nil
}
func (m *Model) formKey(msg tea.KeyPressMsg) tea.Cmd {
	f := m.Form
	if f == nil {
		return nil
	}
	key := msg.String()
	switch key {
	case "esc":
		if f.Dirty {
			m.Mode = "leave"
		} else {
			m.Mode = "list"
		}
		return nil
	case "tab", "down":
		return f.focus(f.Focus + 1)
	case "shift+tab", "up":
		return f.focus(f.Focus - 1)
	case "ctrl+s":
		if f.Kind == "journal" {
			return m.saveDraft(false)
		}
		return m.submitForm()
	case "ctrl+enter":
		return m.submitForm()
	case "enter":
		if f.Focus == len(f.Fields)-1 {
			return m.submitForm()
		}
		return f.focus(f.Focus + 1)
	case "ctrl+n":
		if f.Kind == "journal" && len(f.Fields) < journalHeaderFields+300 {
			f.addLine("", "", "")
			f.Dirty = true
			return f.focus(len(f.Fields) - 3)
		}
	case "ctrl+d":
		if f.Kind == "journal" && len(f.Fields) > journalHeaderFields+6 {
			line := max(0, (f.Focus-journalHeaderFields)/3)
			at := journalHeaderFields + line*3
			f.removeLine(line)
			f.Dirty = true
			return f.focus(min(at, len(f.Fields)-1))
		}
	case "ctrl+g":
		if f.Kind == "journal" && f.value(3) != "" {
			client, id := m.Client, f.value(3)
			return m.task("source", "", func(ctx context.Context) (any, error) {
				return client.SourcesGet(ctx, api.SourceGetInput{SourceID: id}, "")
			})
		}
	case "ctrl+p":
		return m.openPicker()
	}
	if f.sourceFieldReadOnly() {
		m.Notice = "Original source facts are retained. Ctrl+g inspects the source."
		return nil
	}
	before := f.Fields[f.Focus].Input.Value()
	var cmd tea.Cmd
	f.Fields[f.Focus].Input, cmd = f.Fields[f.Focus].Input.Update(msg)
	if before != f.Fields[f.Focus].Input.Value() {
		f.Dirty = true
	}
	return cmd
}
func (m *Model) openPicker() tea.Cmd {
	f := m.Form
	if f == nil {
		return nil
	}
	target := f.Focus
	choices := []Choice{}
	if f.Kind == "journal" && target >= journalHeaderFields {
		target = journalHeaderFields + ((target-journalHeaderFields)/3)*3
		for _, account := range m.Data.Accounts.Accounts {
			choices = append(choices, Choice{ID: account.ID, Label: account.Code + " · " + account.Name, Disabled: account.ClosedOn != nil})
		}
	} else {
		for _, value := range f.Fields[target].Choices {
			choices = append(choices, Choice{ID: value, Label: value})
		}
	}
	if len(choices) == 0 {
		m.Notice = "This field has no picker. Enter its exact value."
		return nil
	}
	search := textinput.New()
	search.Prompt = "Search: "
	search.CharLimit = 200
	search.SetStyles(textinput.Styles{})
	m.Picker = &Picker{Search: search, Choices: choices, Target: target}
	m.Mode = "picker"
	return m.Picker.Search.Focus()
}
func (m *Model) pickerChoices() []Choice {
	if m.Picker == nil {
		return nil
	}
	query := strings.ToLower(m.Picker.Search.Value())
	choices := []Choice{}
	for _, choice := range m.Picker.Choices {
		if strings.Contains(strings.ToLower(choice.ID+" "+choice.Label), query) {
			choices = append(choices, choice)
		}
	}
	return choices
}
func (m *Model) pickerKey(msg tea.KeyPressMsg) tea.Cmd {
	choices := m.pickerChoices()
	picker := m.Picker
	switch msg.String() {
	case "esc":
		m.Mode = "form"
		return m.Form.focus(m.Form.Focus)
	case "up":
		picker.Cursor = max(0, picker.Cursor-1)
		return nil
	case "down":
		picker.Cursor = min(max(0, len(choices)-1), picker.Cursor+1)
		return nil
	case "enter":
		if len(choices) > 0 {
			choice := choices[min(picker.Cursor, len(choices)-1)]
			if choice.Disabled {
				m.Notice = "Closed account cannot be selected."
				return nil
			}
			m.Form.Fields[picker.Target].Input.SetValue(choice.ID)
			m.Form.Dirty = true
			m.Mode = "form"
			return m.Form.focus(min(picker.Target+1, len(m.Form.Fields)-1))
		}
		return nil
	}
	var cmd tea.Cmd
	picker.Search, cmd = picker.Search.Update(msg)
	picker.Cursor = 0
	return cmd
}
func (m *Model) selectedAccount() *api.AccountRow {
	accounts := m.accounts()
	index := m.Cursor[m.Area]
	if index < 0 || index >= len(accounts) {
		return nil
	}
	account := accounts[index]
	return &account
}
func (m *Model) accounts() []api.AccountRow {
	rows := []api.AccountRow{}
	for _, account := range m.Data.Accounts.Accounts {
		if m.Area != 0 || m.AccountSearch == "" || strings.Contains(strings.ToLower(account.Code+" "+account.Name), strings.ToLower(m.AccountSearch)) {
			rows = append(rows, account)
		}
	}
	return rows
}
func (m *Model) reportRows() []api.StatementRow {
	if m.Statement == 1 {
		return m.Data.Reports.ProfitAndLoss.Rows
	}
	if m.Statement == 2 {
		return m.Data.Reports.BalanceSheet.Rows
	}
	rows := []api.StatementRow{}
	for _, row := range m.Data.Reports.TrialBalance.Rows {
		rows = append(rows, api.StatementRow{AccountID: row.AccountID, Code: row.Code, Name: row.Name, Role: row.Role, Amount: row.SignedBalance})
	}
	return rows
}
func (m *Model) rowCount() int {
	switch m.Area {
	case 0:
		return len(m.accounts())
	case 1:
		if m.Drafts {
			return len(m.Data.Drafts.Drafts)
		}
		return len(m.Data.Journal.Entries)
	case 2:
		if m.Data.Activity != nil {
			return len(m.Data.Activity.Rows)
		}
		return len(m.accounts())
	case 3:
		return len(m.reportRows())
	case 4:
		return len(m.Data.Periods.Periods)
	}
	return 0
}
func (m *Model) clamp() { m.Cursor[m.Area] = min(max(0, m.Cursor[m.Area]), max(0, m.rowCount()-1)) }
func (m *Model) openSelected() tea.Cmd {
	m.clamp()
	if m.rowCount() == 0 {
		return nil
	}
	index := m.Cursor[m.Area]
	switch m.Area {
	case 0:
		account := m.selectedAccount()
		m.detail("Account", m.accountContent(*account))
	case 1:
		if !m.Drafts {
			return m.journal(m.Data.Journal.Entries[index].ID, false)
		}
		draft := m.Data.Drafts.Drafts[index]
		m.DraftReadStatus = draft.Status
		m.DraftPostingOperationID = ""
		if draft.PostingOperationID != nil {
			m.LastOperationID = *draft.PostingOperationID
			m.DraftPostingOperationID = *draft.PostingOperationID
		}
		if draft.Status != "draft" {
			m.Form = journalForm(draft.Data, draft.ID, draft.Version)
			instruction := "The posting is unresolved. o inspects its original identity; u resumes a retained client request. r reopens only if the server confirms a durable rejection."
			if draft.Status == "rejected" {
				instruction = "Use r to recover this draft for editing. The rejected operation remains; o inspects it."
			}
			m.detail("Retained draft · "+draft.Status, jsonText(mustJSON(draft))+"\n\n"+instruction)
			return nil
		}
		m.Form = journalForm(draft.Data, draft.ID, draft.Version)
		m.Mode = "form"
		return m.Form.focus(0)
	case 2:
		if m.Data.Activity != nil {
			return m.journal(m.Data.Activity.Rows[index].JournalID, true)
		}
		return m.activity(m.accounts()[index].ID, 1)
	case 3:
		return m.activity(m.reportRows()[index].AccountID, 1)
	case 4:
		return m.periodForm(m.Data.Periods.Periods[index])
	}
	return nil
}
func (m *Model) page(delta int) tea.Cmd {
	if m.Area == 2 && m.Data.Activity != nil {
		scope := m.Data.Activity
		if delta > 0 && scope.Page*scope.PageSize >= scope.Count {
			return nil
		}
		return m.activity(scope.Account.ID, max(1, scope.Page+delta))
	}
	if m.Area != 1 {
		return nil
	}
	count, size := m.Data.Journal.Count, m.Data.Journal.PageSize
	if m.Drafts {
		count, size = m.Data.Drafts.Count, m.Data.Drafts.PageSize
	}
	if delta > 0 && m.Pages[1]*size >= count {
		return nil
	}
	revision := m.Data.Journal.Scope.Revision
	m.Revision = &revision
	m.Pages[1] = max(1, m.Pages[1]+delta)
	m.Cursor[1] = 0
	return m.reload()
}
func (m *Model) discard() tea.Cmd {
	if !m.Drafts || len(m.Data.Drafts.Drafts) == 0 {
		return nil
	}
	draft := m.Data.Drafts.Drafts[m.Cursor[1]]
	client, id := m.Client, api.NewOperationID()
	return m.task("discarded", id, func(ctx context.Context) (any, error) {
		return client.DraftsDiscard(ctx, api.DraftVersionInput{DraftID: draft.ID, ExpectedVersion: draft.Version}, id)
	})
}
func mustJSON(value any) json.RawMessage { raw, _ := json.Marshal(value); return raw }
func jsonText(raw json.RawMessage) string {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return string(raw)
	}
	formatted, _ := json.MarshalIndent(value, "", "  ")
	return string(formatted)
}
