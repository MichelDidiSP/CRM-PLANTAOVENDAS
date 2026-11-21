"""Real layout regression check. Run against Vite using the local mock database.

python scripts/check_test_time_bar.py URL BASELINE_URL
Requires Playwright (installed separately in CI, not in application dependencies).
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

artifacts = Path('test-results')
artifacts.mkdir(exist_ok=True)


def open_test(browser, url, width, height):
    page = browser.new_page(viewport={'width': width, 'height': height})
    page.add_init_script("localStorage.setItem('plantao_test_timestamp', String(Date.parse('2040-01-23T11:30:00Z')))")
    page.goto(url)
    page.get_by_role('button', name='TESTE', exact=True).click()
    page.get_by_role('region', name='Controles de tempo do TESTE', exact=True).wait_for()
    page.evaluate('window.scrollTo(0, 0)')
    page.wait_for_timeout(150)
    return page


def geometry(page):
    return page.evaluate('''() => {
      const bar = document.querySelector('[aria-label="Controles de tempo do TESTE"]');
      return [...bar.querySelectorAll('p, input, button'), document.querySelector('main'),
        document.querySelector('[aria-label="Clientes Inseridos no Teste"]')].map(el => {
        const r = el.getBoundingClientRect(), s = getComputedStyle(el);
        return {x:r.x, y:r.y, width:r.width, height:el.tagName === 'MAIN' ? null : r.height, color:s.color,
          background:s.backgroundColor, font:s.font, padding:s.padding};
      });
    }''')


with sync_playwright() as p:
    browser = p.chromium.launch()
    try:
        for width, height in [(1440, 900), (1024, 768), (390, 844)]:
            old = open_test(browser, sys.argv[2], width, height)
            page = open_test(browser, sys.argv[1], width, height)
            try:
                before, after = geometry(old), geometry(page)
                assert before == after, json.dumps({'width':width, 'before':before, 'after':after})
                old.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)')
                old.wait_for_timeout(150)
                old_y = old.get_by_role('region', name='Controles de tempo do TESTE', exact=True).bounding_box()['y']
                assert old_y < -10, f'Baseline should reproduce released bar: {old_y}'

                for view in ['Recepção', 'Motor da Fila', 'Auditoria']:
                    page.evaluate('window.scrollTo(0, 0)')
                    page.get_by_role('button', name=view, exact=True).click()
                    bar = page.get_by_role('region', name='Controles de tempo do TESTE', exact=True)
                    top = bar.bounding_box()['y']
                    bottom = page.evaluate('document.documentElement.scrollHeight - innerHeight')
                    assert bottom > top, f'Fixture must allow scrolling: {view}, {width}'
                    positions = [min(top + 30, bottom), (top + bottom) / 2, bottom]
                    for scroll in positions:
                        page.evaluate('(y) => window.scrollTo(0, y)', scroll)
                        page.wait_for_timeout(100)
                        rect = bar.bounding_box()
                        assert abs(rect['y']) <= 1, f'{view}/{width}, scroll={scroll}, rect={rect}'
                        assert rect['x'] >= 0 and rect['x'] + rect['width'] <= width
                        assert page.get_by_role('button', name='TESTE', exact=True).get_attribute('aria-expanded') == 'true'
                    page.screenshot(path=str(artifacts / f'time-bar-{width}-{view.replace(" ", "-")}.png'))
                    time_input = bar.locator('input[type="time"]')
                    minute = int(time_input.input_value().split(':')[1])
                    bar.get_by_role('button', name='+1 min', exact=True).click()
                    assert int(time_input.input_value().split(':')[1]) == (minute + 1) % 60
                print(f'{width}x{height}: baseline y={old_y}; initial appearance preserved; pinned through all 3 views; +1 min works')
            finally:
                page.screenshot(path=str(artifacts / f'time-bar-last-{width}.png'))
                page.close()
                old.close()
    finally:
        browser.close()
