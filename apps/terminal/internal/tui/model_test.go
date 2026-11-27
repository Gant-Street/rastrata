package tui

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/Gant-Street/rastrata/apps/terminal/internal/api"
)

func key(text string) tea.KeyPressMsg {
	special := map[string]rune{"enter": tea.KeyEnter, "esc": tea.KeyEscape, "tab": tea.KeyTab, "up": tea.KeyUp, "down": tea.KeyDown, "f1": tea.KeyF1, "f2": tea.KeyF2}
	if code, exists := special[text]; exists {
		return tea.KeyPressMsg(tea.Key{Code: code})
	}
	if strings.HasPrefix(text, "ctrl+") {
		value := []rune(strings.TrimPrefix(text, "ctrl+"))[0]
		if text == "ctrl+enter" {
			value = tea.KeyEnter
		}
		return tea.KeyPressMsg(tea.Key{Code: value, Mod: tea.ModCtrl})
	}
	return tea.KeyPressMsg(tea.Key{Code: []rune(text)[0], Text: text})
}
func settle(t *testing.T, m *Model, cmd tea.Cmd) {
	t.Helper()
	for i := 0; cmd != nil && i < 20; i++ {
		message := cmd()
		_, cmd = m.Update(message)
	}
	if m.Busy {
		t.Fatal("model failed to settle")
	}
	if strings.HasPrefix(m.Notice, "ERROR") {
		t.Fatal(m.Notice)
	}
}
func testModel(t *testing.T) *Model {
	t.Helper()
	client, err := api.New("http://127.0.0.1:4010", "local-book", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := NewModel(context.Background(), client)
	m.NoColor = true
	return m
}

func TestEditorKeyboardPickerPasteAndFocus(t *testing.T) {
	m := testModel(t)
	m.Data.Book.Setup = &api.BookSetup{Name: "Example Co", Currency: "USD", FiscalYear: 2026}
	m.Data.Accounts.Accounts = []api.AccountRow{{ID: "1000", Code: "1000", Name: "Cash"}, {ID: "3000", Code: "3000", Name: "Capital"}}
	m.newJournal(nil)
	m.Form.focus(6)
	m.Update(key("ctrl+p"))
	if m.Mode != "picker" {
		t.Fatal("account picker did not open")
	}
	m.Update(tea.PasteMsg{Content: "1000"})
	m.Update(key("enter"))
	if m.Form.value(6) != "1000" || m.Form.Focus != 7 {
		t.Fatal("picker did not select exact ID and next field")
	}
	m.Update(tea.PasteMsg{Content: "1000.00"})
	if m.Form.value(7) != "1000.00" {
		t.Fatal("paste changed exact amount")
	}
	m.Update(key("ctrl+n"))
	if len(m.Form.Fields) != 15 {
		t.Fatal("new journal line missing")
	}
	m.Form.Fields[12].Input.SetValue("3000")
	m.Form.focus(9)
	m.Update(key("ctrl+d"))
	if len(m.Form.Fields) != 12 {
		t.Fatal("journal line removal failed")
	}
	if m.Form.value(9) != "3000" || m.Form.Fields[9].Label != "Line 2 account" || m.Form.Fields[9].Path != "input.data.lines[1].accountId" || m.Form.Fields[10].Path != "input.data.lines[1].debit" || m.Form.Fields[11].Path != "input.data.lines[1].credit" {
		t.Fatal("remaining journal line lost its data or validation paths")
	}
	m.Update(tea.WindowSizeMsg{Width: 40, Height: 20})
	if m.Form.Fields[m.Form.Focus].Input.Width() > 32 {
		t.Fatal("input failed to resize")
	}
	m.Update(key("f1"))
	if m.Mode != "help" {
		t.Fatal("keyboard help unavailable inside editor")
	}
	m.Update(key("esc"))
	if m.Mode != "form" {
		t.Fatal("help lost editor focus")
	}
	m.Update(key("esc"))
	if m.Mode != "leave" {
		t.Fatal("unsaved edits disappeared without confirmation")
	}
	m.Update(key("n"))
	if m.Mode != "form" {
		t.Fatal("cancel lost editor")
	}
}
func TestCancellationPreservesIdentityAndIgnoresLateResults(t *testing.T) {
	m := testModel(t)
	m.Mode = "review"
	id := api.NewOperationID()
	cmd := m.task("receipt", id, func(ctx context.Context) (any, error) {
		return api.MutationReceipt{Disposition: "committed", OperationID: id}, nil
	})
	old := m.Epoch
	m.Update(key("2"))
	if m.Area != 0 {
		t.Fatal("pending mutation allowed dependent navigation")
	}
	m.Update(key("esc"))
	if m.Mode != "recovery" || m.LastOperationID != id || !strings.Contains(m.Notice, "unresolved") {
		t.Fatal("cancel falsely resolved a write")
	}
	message := cmd()
	m.Update(message)
	if m.Mode != "recovery" || m.Epoch == old {
		t.Fatal("late response replaced recovery state")
	}
	m.Update(key("o"))
	if m.Form.Kind != "status" || m.Form.value(0) != id {
		t.Fatal("original identity unavailable for inspection")
	}
}
func TestNoColorNarrowFinancialValuesAndUntrustedLabels(t *testing.T) {
	m := testModel(t)
	m.Data.Book.Setup = &api.BookSetup{Name: "Example Co\x1b]2;injected\x07", Currency: "USD", FiscalYear: 2026}
	m.Area = 3
	amount := "1000000000000000.01"
	m.Data.Reports = api.CoreReports{AsOf: "2026-01-31", Currency: "USD", Basis: "accrual", BookRevision: "9007199254740993", PopulationHash: strings.Repeat("a", 64), TrialBalance: api.TrialBalance{Rows: []api.ReportRow{{AccountID: "1000", Code: "1000", Name: "Cash\x1b[31m", Debit: amount, Credit: "0.00"}}, Debit: amount, Credit: amount, Balanced: true}}
	m.Update(tea.WindowSizeMsg{Width: 40, Height: 20})
	view := m.View().Content
	if strings.ContainsAny(m.View().WindowTitle, "\x1b\x07") {
		t.Fatal("book label injected terminal title controls")
	}
	if strings.Contains(view, "\x1b") || !strings.Contains(view, amount) || !strings.Contains(view, "TOTAL Cr "+amount) || !strings.Contains(view, "9007199254740993") {
		t.Fatalf("narrow view lost scope/amounts: %s", view)
	}
	m.Mode = "list"
	m.Update(key("i"))
	if !strings.Contains(m.Detail.GetContent(), m.Data.Reports.PopulationHash) {
		t.Fatal("full report identity unavailable")
	}
}
func TestFormFieldErrorsRemainReadable(t *testing.T) {
	m := testModel(t)
	m.newJournal(nil)
	epoch := m.Epoch
	failure := m.Client.Failure("invalid_input", "Select an account", "", false)
	failure.Response.Error.Details = []api.FieldError{{Path: "input.data.lines[0].accountId", Message: "Expected account ID"}}
	m.Update(Result{Epoch: epoch, Err: failure})
	if m.Form.Focus != journalHeaderFields {
		t.Fatal("field error did not focus relevant input")
	}
	m.Update(key("f2"))
	if !strings.Contains(m.Detail.GetContent(), "input.data.lines[0].accountId") {
		t.Fatal("full field error not inspectable")
	}
}

func realClient(t *testing.T) *api.Client {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	command := exec.Command("bun", "apps/api/src/main.ts")
	command.Dir = "../../../.."
	command.Env = append(os.Environ(), "RASTRATA_LOCAL_DEV=1", fmt.Sprintf("RASTRATA_API_PORT=%d", port), "RASTRATA_LOCAL_DB="+filepath.Join(t.TempDir(), "book.sqlite"))
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = command.Process.Signal(os.Interrupt); _ = command.Wait() })
	endpoint := fmt.Sprintf("http://127.0.0.1:%d", port)
	ready := false
	probe := http.Client{Timeout: time.Second}
	for i := 0; i < 100; i++ {
		response, err := probe.Get(endpoint + "/health")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == 200 {
				ready = true
				break
			}
		}
		time.Sleep(30 * time.Millisecond)
	}
	if !ready {
		t.Fatal("independent local API failed to start")
	}
	client, err := api.New(endpoint, "local-book", t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return client
}
func TestTUIWorkflowsUseRealServiceAndKnownFigures(t *testing.T) {
	client := realClient(t)
	m := NewModel(context.Background(), client)
	m.NoColor = true
	settle(t, m, m.Init())
	if m.Form == nil || m.Form.Kind != "setup" {
		t.Fatal("fresh book setup missing")
	}
	m.Form.Fields[0].Input.SetValue("TUI Co")
	m.Form.Fields[2].Input.SetValue("2026")
	settle(t, m, m.submitForm())
	journal := func(reference, debitID, creditID, amount string) string {
		t.Helper()
		data := api.JournalDraftData{Date: "2026-01-15", Reference: reference, Narration: reference, Lines: []api.JournalLine{{AccountID: debitID, Debit: amount, Credit: ""}, {AccountID: creditID, Debit: "", Credit: amount}}}
		m.Area = 1
		m.newJournal(&data)
		settle(t, m, m.saveDraft(true))
		if m.Mode != "review" || m.Plan == nil || !m.Plan.Valid {
			t.Fatal("valid journal did not reach review")
		}
		id := m.Form.DraftID
		before, err := client.ReportsGet(context.Background(), api.ReportsInput{AsOf: "2026-01-31"}, "")
		if err != nil {
			t.Fatal(err)
		}
		if reference == "OPEN" && before.BalanceSheet.Assets != "0.00" {
			t.Fatal("preview posted accounting effects")
		}
		settle(t, m, m.commit())
		if !strings.HasPrefix(m.Notice, "COMMITTED") {
			t.Fatal("durable receipt disappeared")
		}
		return id
	}
	journal("OPEN", "1000", "3000", "1000.00")
	journal("SALE", "1000", "4000", "200.00")
	expense := journal("EXPENSE", "5000", "1000", "50.00")
	if m.Data.Reports.BalanceSheet.Assets != "1150.00" || m.Data.Reports.ProfitAndLoss.NetIncome != "150.00" || m.Data.Reports.TrialBalance.Debit != "1200.00" {
		t.Fatal("TUI figures differ from independent expected accounting")
	}
	settle(t, m, m.activity("1000", 1))
	scope := *m.Data.Activity
	if scope.ClosingBalance != "1150.00" {
		t.Fatal("running ledger balance incorrect")
	}
	settle(t, m, m.journal(expense, true))
	if !strings.Contains(m.Detail.GetContent(), "viewed at revision "+scope.Revision) {
		t.Fatal("journal lost pinned scope")
	}
	m.reverseForm(expense)
	m.Form.Fields[0].Input.SetValue("2026-01-17")
	m.Form.Fields[1].Input.SetValue("Entered in error")
	settle(t, m, m.submitForm())
	settle(t, m, m.commit())
	if m.Data.Reports.BalanceSheet.Assets != "1200.00" || m.Data.Reports.ProfitAndLoss.NetIncome != "200.00" {
		t.Fatal("immutable correction incorrect")
	}
	// The initial population remains available after the correction.
	pinned, err := client.ActivityGet(context.Background(), api.ActivityInput{AccountID: "1000", AsOf: scope.AsOf, Revision: &scope.Revision, PopulationHash: &scope.PopulationHash, From: scope.From, To: scope.To}, "")
	if err != nil || pinned.ClosingBalance != "1150.00" {
		t.Fatal("old population changed")
	}
	m.accountForm(nil, false)
	m.Form.Fields[0].Input.SetValue("5100")
	m.Form.Fields[1].Input.SetValue("Supplies")
	settle(t, m, m.submitForm())
	settle(t, m, m.commit())
	if len(m.Data.Accounts.Accounts) != 5 {
		t.Fatal("account creation missing")
	}
	m.periodForm(m.Data.Periods.Periods[0])
	m.Form.Fields[1].Input.SetValue("Reviewed January")
	settle(t, m, m.submitForm())
	if m.Plan.Effects.Periods[0].ReportPopulationHash == nil {
		t.Fatal("close review omitted report package")
	}
	settle(t, m, m.commit())
	if m.Data.Periods.Periods[0].Status != "closed" {
		t.Fatal("period did not close")
	}
	data := api.JournalDraftData{Date: "2026-01-15", Reference: "LATE", Narration: "Late evidence", Lines: []api.JournalLine{{AccountID: "1000", Debit: "1.00", Credit: ""}, {AccountID: "3000", Debit: "", Credit: "1.00"}}}
	m.newJournal(&data)
	settle(t, m, m.saveDraft(true))
	if m.Plan.Valid {
		t.Fatal("closed-period preparation admitted")
	}
	if m.commit() != nil {
		t.Fatal("invalid TUI plan submitted")
	}
	m.Mode = "list"
	m.periodForm(m.Data.Periods.Periods[0])
	m.Form.Fields[1].Input.SetValue("Late evidence review")
	settle(t, m, m.submitForm())
	settle(t, m, m.commit())
	if m.Data.Periods.Periods[0].Status != "open" {
		t.Fatal("period did not reopen")
	}
	// One executable's CLI can inspect the same service and population.
	report, err := client.ReportsGet(context.Background(), api.ReportsInput{AsOf: "2026-01-31"}, "")
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(report)
	if !strings.Contains(string(raw), `"assets":"1200.00"`) {
		t.Fatal("shared client changed amount transport")
	}
}

func TestRejectedDraftRecoversThroughKeyboardAndRequiresNewReview(t *testing.T) {
	client := realClient(t)
	ctx := context.Background()
	_, err := client.BookSetup(ctx, api.BookSetup{Name: "Recovery Co", Currency: "USD", FiscalYear: 2026, PeriodModel: "monthly", Accounts: []api.InitialAccount{{Code: "1000", Name: "Cash", Role: "asset"}, {Code: "3000", Name: "Capital", Role: "equity"}}}, api.NewOperationID())
	if err != nil {
		t.Fatal(err)
	}
	m := NewModel(ctx, client)
	settle(t, m, m.Init())
	data := api.JournalDraftData{Date: "2026-01-15", Reference: "RECOVER", Narration: "Owner contribution", Lines: []api.JournalLine{{AccountID: "1000", Debit: "1000.00"}, {AccountID: "3000", Credit: "1000.00"}}}
	m.newJournal(&data)
	settle(t, m, m.saveDraft(true))
	original := *m.Plan
	draftID := m.Form.DraftID
	account, err := client.AccountsPrepareCreate(ctx, api.AccountCreateInput{Code: "1100", Name: "Savings", Role: "asset", EffectiveOn: "2026-01-01"}, api.NewOperationID())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.OperationsCommit(ctx, api.CommitInput{PlanID: account.PlanID, PlanHash: account.PlanHash}, account.PlanID); err != nil {
		t.Fatal(err)
	}
	settle(t, m, m.commit())
	if !strings.HasPrefix(m.Notice, "REJECTED") {
		t.Fatal("stale plan was not rejected")
	}
	m.Area, m.Mode, m.Drafts = 1, "list", true
	settle(t, m, m.openSelected())
	if m.Mode != "detail" || m.DraftReadStatus != "rejected" {
		t.Fatal("rejected draft is not inspectable")
	}
	_, command := m.Update(key("r"))
	settle(t, m, command)
	if m.Mode != "form" || m.Form.DraftID != draftID || m.Form.Version != 2 || m.Plan != nil {
		t.Fatal("recovery lost the same draft or silently kept the old review")
	}
	if m.Data.Reports.BalanceSheet.Assets != "0.00" {
		t.Fatal("recovery changed balances")
	}
	settle(t, m, m.saveDraft(true))
	if m.Mode != "review" || !m.Plan.Valid || m.Plan.PlanID == original.PlanID {
		t.Fatal("recovered draft lacks a new review")
	}
	settle(t, m, m.commit())
	if m.Data.Reports.BalanceSheet.Assets != "1000.00" || len(m.Data.Journal.Entries) != 1 {
		t.Fatal("recovered posting has wrong effects")
	}
	old, err := client.OperationsCommit(ctx, api.CommitInput{PlanID: original.PlanID, PlanHash: original.PlanHash}, original.PlanID)
	if err != nil || old.Disposition != "rejected" {
		t.Fatal("old rejection changed")
	}
	draft, err := client.DraftsGet(ctx, api.DraftIdInput{DraftID: draftID}, "")
	if err != nil || draft.Status != "posted" || draft.RecoveredFromOperationID == nil || *draft.RecoveredFromOperationID != original.PlanID {
		t.Fatal("old retry corrupted the recovered draft")
	}
}

func TestResumedApplicationWriteLeavesRecoveryAndRefreshesCurrentDrafts(t *testing.T) {
	m := testModel(t)
	m.Mode, m.RecoverMode = "recovery", "form"
	m.Form = journalForm(api.JournalDraftData{}, "draft", 1)
	m.Plan = &api.PreparedOperation{PlanID: api.NewOperationID(), Valid: true}
	draft := api.SavedDraft{ID: "draft", Version: 2, Status: "draft"}
	raw, _ := json.Marshal(draft)
	_, command := m.Update(Result{Epoch: m.Epoch, Kind: "resume", Value: api.Response{OK: true, Data: raw}})
	if command == nil || !m.Busy || m.ActiveWrite || m.BackMode != "list" || m.Form != nil || m.Plan != nil {
		t.Fatal("completed recovery stayed locked or retained a stale editor/plan")
	}
	data := Snapshot{Book: api.BookContext{Setup: &api.BookSetup{Name: "Recovery Co", Currency: "USD", FiscalYear: 2026}}, Drafts: api.DraftPage{Drafts: []api.SavedDraft{draft}}, Reports: api.CoreReports{AsOf: "2026-01-31"}}
	m.Update(Result{Epoch: m.Epoch, Kind: "reload", Value: data})
	m.Update(key("esc"))
	if m.Mode != "list" {
		t.Fatal("recovery result cannot return to refreshed book")
	}
	m.Area = 1
	m.openSelected()
	if m.Mode != "form" || m.Form.Version != 2 || m.Plan != nil {
		t.Fatal("editing resumed an obsolete snapshot or review")
	}
}

func TestSavedSourceFactsRemainExactThroughAccountingEdits(t *testing.T) {
	m := testModel(t)
	empty := ""
	source := &api.SourceEvent{ID: "receipt-001", Description: "Original facts\nwith another line", EvidenceReference: &empty}
	data := api.JournalDraftData{Date: "2026-01-15", Source: source, Lines: []api.JournalLine{{}, {}}}
	m.Form = journalForm(data, "saved-draft", 1)
	m.Mode = "form"
	m.Form.focus(4)
	m.Update(tea.PasteMsg{Content: "Changed facts"})
	if m.Form.draftData().Source != source || !m.Form.unchanged() {
		t.Fatal("saved source descriptor changed during editing")
	}
	m.Form.focus(journalHeaderFields + 1)
	m.Update(tea.PasteMsg{Content: "25.00"})
	if m.Form.draftData().Lines[0].Debit != "25.00" || m.Form.draftData().Source != source {
		t.Fatal("accounting edit changed original source facts")
	}
}
