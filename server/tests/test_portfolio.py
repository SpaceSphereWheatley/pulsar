import portfolio

TEST_USER = "testuser"


def test_empty_portfolio_shape():
    p = portfolio._empty()
    assert p["cash"] == 0.0
    assert p["total_deposited"] == 0.0
    assert p["total_withdrawn"] == 0.0
    assert p["holdings"] == {}
    assert p["transactions"] == []


def test_load_portfolio_returns_fresh_when_no_file(tmp_path, monkeypatch):
    monkeypatch.setattr(portfolio, "_PORTFOLIO_DIR", tmp_path)
    p = portfolio.load_portfolio(TEST_USER)
    assert p["cash"] == 0.0
    assert p["holdings"] == {}


def test_save_and_load_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(portfolio, "_PORTFOLIO_DIR", tmp_path)
    original = portfolio._empty()
    original["cash"] = 5_000.0
    original["holdings"]["bitcoin"] = {"amount": 0.05, "avg_buy_price": 60_000.0}
    portfolio.save_portfolio(TEST_USER, original)

    loaded = portfolio.load_portfolio(TEST_USER)
    assert loaded["cash"] == 5_000.0
    assert loaded["holdings"]["bitcoin"]["amount"] == 0.05


def test_reset_clears_holdings(tmp_path, monkeypatch):
    monkeypatch.setattr(portfolio, "_PORTFOLIO_DIR", tmp_path)
    p = portfolio._empty()
    p["cash"] = 100.0
    p["holdings"]["bitcoin"] = {"amount": 0.1, "avg_buy_price": 50_000.0}
    portfolio.save_portfolio(TEST_USER, p)

    reset = portfolio.reset_portfolio(TEST_USER)
    assert reset["cash"] == 0.0
    assert reset["holdings"] == {}

    loaded = portfolio.load_portfolio(TEST_USER)
    assert loaded["cash"] == 0.0


def test_load_portfolio_handles_corrupt_file(tmp_path, monkeypatch):
    monkeypatch.setattr(portfolio, "_PORTFOLIO_DIR", tmp_path)
    (tmp_path / f"portfolio_{TEST_USER}.json").write_text("not valid json {{")
    p = portfolio.load_portfolio(TEST_USER)
    assert p["cash"] == 0.0


def test_separate_users_have_separate_portfolios(tmp_path, monkeypatch):
    monkeypatch.setattr(portfolio, "_PORTFOLIO_DIR", tmp_path)
    p_alice = portfolio._empty()
    p_alice["cash"] = 1_000.0
    portfolio.save_portfolio("alice", p_alice)

    p_bob = portfolio.load_portfolio("bob")
    assert p_bob["cash"] == 0.0
