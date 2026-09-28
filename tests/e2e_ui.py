import json, sys, time
from playwright.sync_api import sync_playwright
BASE = "http://localhost:8080"
errors = []
def step(name, ok, extra=""):
    print(("OK  " if ok else "FAIL"), name, extra); 
    if not ok: errors.append(name)
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={"width": 1500, "height": 1000}, accept_downloads=True)
    page = ctx.new_page()
    page.on("console", lambda m: print("  [console]", m.type, m.text) if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: print("  [pageerror]", e))
    page.goto(BASE, wait_until="networkidle")
    step("login screen shown", page.is_visible("#loginScreen") and page.is_visible("#loginForm"))
    page.screenshot(path="/home/user/.arena/n_login.png")
    # wrong password
    page.fill("#loginForm [name=email]", "demo@local"); page.fill("#loginForm [name=password]", "wrong"); page.click("#btnLogin")
    page.wait_for_selector("#loginError:not([hidden])", timeout=5000)
    step("wrong password message", "salah" in page.inner_text("#loginError"), page.inner_text("#loginError"))
    page.fill("#loginForm [name=password]", "demo1234"); page.click("#btnLogin")
    page.wait_for_selector("#loginScreen[hidden]", state="attached", timeout=15000)
    page.wait_for_selector("#grid tbody", timeout=15000)
    n_items = page.locator("#grid tbody").count()
    step("grid loaded after login", n_items == 57, f"tbodies={n_items}")
    step("count info", "57" in page.inner_text("#countInfo"), page.inner_text("#countInfo"))
    step("year select", page.input_value("#yearSelect") == "2026")
    step("title", "Master Forecast" in page.inner_text("#appTitle"), page.inner_text("#appTitle"))
    page.screenshot(path="/home/user/.arena/n_grid.png")
    # ---- 15008 end stock values
    def cell_text(code, row, m):
        return page.locator(f'#grid tbody[data-id] tr').nth(0).count() and page.evaluate("""([code,row,m]) => {
            const tb = [...document.querySelectorAll('#grid tbody')].find(t => t.querySelector('.code')?.textContent.trim() === code);
            const tr = tb.querySelectorAll('tr')[row]; const td = tr.querySelectorAll('td.c-m, td.cell, td[data-m]')[m-1] || tr.children[m+1];
            return td.textContent.trim(); }""", [code, row, m])
    tb = page.locator("#grid tbody").filter(has_text="15008").first
    rows = tb.locator("tr")
    print("  15008 rows:", rows.count())
    end_row = rows.nth(3).inner_text().replace("\n", " | ")
    print("  15008 end row:", end_row[:160])
    step("15008 end stock Aug = 2,250 (opening 1250 chain)", "2.250" in end_row or "2,250" in end_row or "2250" in end_row)
    # ---- cell edit: set 15008 Sep actual = 100 → End Sep = 2150
    target = tb.locator("input.cell[data-f='actual'][data-m='9']").first
    target.click(); target.fill("100"); page.keyboard.press("Enter")
    time.sleep(1.2)
    end_row = rows.nth(3).inner_text().replace("\n", " | ")
    step("edit cell persisted → End Sep 2,150", "2.150" in end_row or "2,150" in end_row or "2150" in end_row, end_row[:200])
    # verify via DB through page reload
    page.reload(wait_until="networkidle"); page.wait_for_selector("#grid tbody", timeout=15000)
    step("session persisted after reload (no login screen)", page.is_hidden("#loginScreen"))
    tb = page.locator("#grid tbody").filter(has_text="15008").first
    txt = tb.locator("tr").nth(1).inner_text()
    step("value survives reload", "100" in txt, txt[:120])
    # ---- paste 12 numbers into forecast row of 15017 (month 1)
    tb2 = page.locator("#grid tbody").filter(has_text="15017").first
    t2 = tb2.locator("input.cell[data-f='forecast'][data-m='1']").first
    t2.click()
    page.evaluate("""() => { const td = document.activeElement; const dt = new DataTransfer(); dt.setData('text/plain', '1\\t2\\t3\\t4\\t5\\t6\\t7\\t8\\t9\\t10\\t11\\t12'); td.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""")
    time.sleep(1.5)
    frow = tb2.locator("tr").nth(0).inner_text().replace("\n", " ")
    step("paste row 12 values", " 12" in frow and " 11" in frow, frow[:160])
    # ---- dashboard
    page.click("button.tab[data-view='dash']")
    page.wait_for_selector("#dash .kpi, #dash .card, #dash", timeout=5000); time.sleep(0.5)
    dash = page.inner_text("#dash")
    step("dashboard rendered", "Di bawah Min" in dash or "below" in dash.lower() or len(dash) > 200, dash[:120].replace("\n", " "))
    page.screenshot(path="/home/user/.arena/n_dash.png")
    page.click("button.tab[data-view='grid']")
    # ---- item CRUD via dialog
    page.click("#btnAdd")
    page.wait_for_selector("#itemDialog[open]")
    f = page.locator("#itemForm")
    f.locator("[name=code]").fill("99999"); f.locator("[name=category]").fill("Chemical"); f.locator("[name=description]").fill("TEST ITEM E2E"); f.locator("[name=uom]").fill("Kg")
    f.locator("[name=min_stock]").fill("10"); f.locator("[name=max_stock]").fill("20")
    if f.locator("[name=opening_stock]").count(): f.locator("[name=opening_stock]").fill("15")
    f.locator("button[type=submit], button[data-submit], .btn.primary").last.click()
    page.wait_for_selector("#itemDialog:not([open])", state="attached", timeout=8000); time.sleep(0.8)
    step("item created", page.locator("#grid tbody").filter(has_text="99999").count() == 1)
    # duplicate code
    page.click("#btnAdd"); page.wait_for_selector("#itemDialog[open]")
    f.locator("[name=code]").fill("99999"); f.locator("[name=description]").fill("dup"); f.locator("button[type=submit], button[data-submit], .btn.primary").last.click()
    time.sleep(1.2)
    err = page.inner_text("#itemFormError")
    step("duplicate code rejected", "sudah ada" in err, err)
    page.click("#itemDialog [data-close]"); time.sleep(0.3)
    # delete: open edit dialog of 99999
    tb3 = page.locator("#grid tbody").filter(has_text="99999").first
    tb3.locator("button[data-act='edit']").first.click()
    page.wait_for_selector("#itemDialog[open]", timeout=5000)
    page.click("#btnDeleteItem")
    page.wait_for_selector("#confirmDialog[open]", timeout=5000); page.click("#confirmOk")
    time.sleep(1.2)
    step("item deleted", page.locator("#grid tbody").filter(has_text="99999").count() == 0)
    # ---- import wizard with SAP file
    page.click("#btnImport")
    page.wait_for_selector("#importDialog[open]")
    page.set_input_files("#importForm [name=file]", "/home/user/file2.xlsx")
    page.wait_for_selector("#importPreview:not([hidden])", timeout=90000)
    time.sleep(0.5)
    pv = page.inner_text("#importDialog")
    step("SAP format detected", "SAP" in pv and ("1.575" in pv or "1,575" in pv or "1575" in pv), pv[:200].replace("\n", " "))
    page.screenshot(path="/home/user/.arena/n_import.png")
    page.click("#btnDoImport"); page.wait_for_selector("#confirmDialog[open]", timeout=10000); page.click("#confirmOk")
    page.wait_for_selector("#importDialog:not([open])", state="attached", timeout=60000); time.sleep(1.0)
    toast = page.inner_text("#toast")
    step("SAP import applied", "54" in toast, toast[:200])
    tb = page.locator("#grid tbody").filter(has_text="15008").first
    txt = tb.locator("tr").nth(1).inner_text()
    step("15008 Sep actual 100 kept (SAP covers Jan–Agu only)", "100" in txt, txt[:100])
    # ---- export
    with page.expect_download(timeout=60000) as dl:
        page.click("#btnExport")
    d = dl.value; path = "/tmp/export_ui.xlsx"; d.save_as(path)
    import os; step("export downloaded", os.path.getsize(path) > 20000, f"{d.suggested_filename} {os.path.getsize(path)} bytes")
    # ---- history dialog
    page.click("#btnMore"); page.click("[data-act='history']")
    page.wait_for_selector("#historyDialog[open]"); time.sleep(0.8)
    h = page.inner_text("#historyBody")
    step("import history shows entry", "SAP" in h and "demo@local" in h, h[:160].replace("\n", " "))
    page.click("#historyDialog [data-close]")
    # ---- settings
    page.click("#btnMore"); page.click("[data-act='settings']"); page.wait_for_selector("#settingsDialog[open]")
    page.fill("#settingsForm [name=company]", "PT TEST COMPANY"); page.locator("#settingsForm button[type=submit], #settingsForm button[data-submit], #settingsForm .btn.primary").last.click()
    page.wait_for_selector("#settingsDialog:not([open])", state="attached", timeout=8000); time.sleep(0.5)
    step("settings saved", "PT TEST COMPANY" in page.inner_text("#appCompany"), page.inner_text("#appCompany"))
    # ---- logout
    page.click("#btnMore"); page.click("[data-act='logout']")
    page.wait_for_selector("#loginScreen:not([hidden])", timeout=8000)
    step("logout shows login", True)
    b.close()
print("\nRESULT:", "ALL OK" if not errors else f"{len(errors)} FAILED: {errors}")
sys.exit(1 if errors else 0)
