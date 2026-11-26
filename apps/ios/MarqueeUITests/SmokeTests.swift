import XCTest

/// Against demo mode (scripts/smoke.sh starts it): sign in, see Home, approve a request.
final class SmokeTests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testSignInSeeHomeApprove() throws {
        let app = XCUIApplication()
        app.launchArguments += ["--reset-for-ui-tests"]
        app.launch()
        allowNotificationsIfAsked()

        // Where is Marquee?
        let address = app.textFields["address-field"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("localhost:9797")
        app.buttons["connect"].tap()

        signIn(app)

        // Home loads.
        XCTAssertTrue(app.staticTexts["Needs you"].waitForExistence(timeout: 15), "Home should show Needs you")
        XCTAssertTrue(app.buttons["avatar"].exists)

        // Requests → approve the first one.
        app.tabBars.buttons["Requests"].tap()
        let approve = app.buttons.matching(NSPredicate(format: "identifier MATCHES 'approve-[0-9]+'"))
        XCTAssertTrue(approve.firstMatch.waitForExistence(timeout: 10))
        let before = approve.count
        XCTAssertGreaterThan(before, 0)
        approve.firstMatch.tap()

        // It leaves the Waiting list, and the undo toast shows.
        XCTAssertTrue(app.buttons["undo"].waitForExistence(timeout: 10))
        let gone = NSPredicate { _, _ in approve.count < before }
        wait(for: [XCTNSPredicateExpectation(predicate: gone, object: nil)], timeout: 10)

        // Library → a title.
        app.tabBars.buttons["Library"].tap()
        let dune = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Dune'")).firstMatch
        XCTAssertTrue(dune.waitForExistence(timeout: 10), "Library should list Dune")
        dune.tap()
        XCTAssertTrue(app.buttons["something-wrong"].waitForExistence(timeout: 10), "The title page should open")
        app.navigationBars.buttons.firstMatch.tap()

        // Discover → ask for something, then take it back inside three seconds.
        app.tabBars.buttons["Discover"].tap()
        let gladiator = app.buttons["card-558449"].firstMatch
        XCTAssertTrue(gladiator.waitForExistence(timeout: 10))
        gladiator.tap()
        let ask = app.buttons["ask"]
        XCTAssertTrue(ask.waitForExistence(timeout: 10))
        ask.tap()
        XCTAssertEqual(ask.label, "Undo")
        ask.tap()
        sleep(4)
        XCTAssertEqual(ask.label, "Ask for it", "Nothing should have been sent")

        // Notifications are on without anyone touching the switch, and stay that way after signing out and back in.
        if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        openYou(app)
        waitForSwitch(app, "1", "Notifications should be on by default")
        signOut(app)
        signIn(app)
        openYou(app)
        waitForSwitch(app, "1", "Still on after signing in again")

        // Switched off stays off, until it's switched back on.
        flipNotifications(app)
        waitForSwitch(app, "0", "It should switch off")
        signOut(app)
        signIn(app)
        openYou(app)
        sleep(3)
        waitForSwitch(app, "0", "Still off after signing in again")
        flipNotifications(app)
        waitForSwitch(app, "1", "It should switch back on")
    }

    /// Home used to come back empty after visiting other tabs; requests and Search used to need a nudge.
    func testHomeComesBackAndTitlesOpen() {
        let app = launch(as: "josh")
        let needs = app.staticTexts["Needs you"]
        XCTAssertTrue(needs.waitForExistence(timeout: 20))
        for tab in ["Library", "Discover", "Requests", "Downloads"] {
            app.tabBars.buttons[tab].tap()
            app.tabBars.buttons["Home"].tap()
            XCTAssertTrue(needs.waitForExistence(timeout: 8), "Home should still show after \(tab)")
        }

        app.tabBars.buttons["Discover"].tap()
        app.buttons["search"].tap()
        let field = app.searchFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        XCTAssertTrue(field.isHittable, "The search field shows without scrolling")
        app.buttons["Done"].tap()

        app.tabBars.buttons["Home"].tap()
        let row = app.buttons.matching(NSPredicate(format: "identifier MATCHES 'request-[0-9]+'")).firstMatch
        for _ in 0..<8 where !row.isHittable { app.swipeUp(velocity: .slow) }
        XCTAssertTrue(row.waitForExistence(timeout: 10), "Home lists recent requests")
        row.tap()
        let page = app.buttons["something-wrong"]
        let sheet = app.staticTexts["Information from TMDB."]
        let opened = NSPredicate { _, _ in page.exists || sheet.exists }
        wait(for: [XCTNSPredicateExpectation(predicate: opened, object: nil)], timeout: 10)
    }

    /// You → What you get: a switch for each message, kept by Marquee.
    func testChoosingWhichNotificationsArrive() {
        let app = launch(as: "josh")
        openYou(app)
        waitForSwitch(app, "1", "Notifications should be on")
        let choices = app.buttons["notification-choices"]
        XCTAssertTrue(choices.waitForExistence(timeout: 10), "What you get shows while notifications are on")
        choices.tap()
        let started = app.switches["notify-stream_started"]
        XCTAssertTrue(app.switches["notify-request_pending"].waitForExistence(timeout: 10))
        for _ in 0..<8 where !started.isHittable { app.swipeUp() }
        XCTAssertTrue(started.isHittable)
        let before = started.value as? String
        let after = before == "1" ? "0" : "1"
        started.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        expectValue(started, after, "The switch should move")
        sleep(2)

        // Leave and come back: what Marquee kept is what shows.
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(choices.waitForExistence(timeout: 5))
        choices.tap()
        XCTAssertTrue(app.switches["notify-request_pending"].waitForExistence(timeout: 10))
        for _ in 0..<8 where !started.isHittable { app.swipeUp() }
        expectValue(started, after, "The choice should be kept")
        started.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        expectValue(started, before ?? "0", "And switch back")
    }

    /// You → Lock Screen cards: which ones Marquee starts by itself.
    func testChoosingLockScreenCards() {
        let app = launch(as: "josh")
        openYou(app)
        let link = app.buttons["lock-screen-cards"]
        XCTAssertTrue(link.waitForExistence(timeout: 10))
        link.tap()
        let watching = app.switches["live-watching"]
        XCTAssertTrue(watching.waitForExistence(timeout: 10))
        let before = watching.value as? String ?? "0"
        let after = before == "1" ? "0" : "1"
        watching.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        expectValue(watching, after, "The switch should move")
        sleep(2)
        app.navigationBars.buttons.firstMatch.tap()
        link.tap()
        expectValue(app.switches["live-watching"], after, "The choice should be kept")
        app.switches["live-watching"].coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
        expectValue(app.switches["live-watching"], before, "And switch back")
    }

    private func expectValue(_ element: XCUIElement, _ value: String, _ why: String) {
        let match = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [match], timeout: 10), .completed, why)
    }

    private func allowNotificationsIfAsked() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 5) { allow.tap() }
    }

    private func signIn(_ app: XCUIApplication) {
        let username = app.textFields["username"]
        XCTAssertTrue(username.waitForExistence(timeout: 10), "Marquee should answer at localhost:9797 (is demo mode running?)")
        username.tap()
        username.typeText("josh")
        let password = app.secureTextFields["password"]
        password.tap()
        password.typeText("correct horse battery")
        app.buttons["sign-in"].tap()
        XCTAssertTrue(app.tabBars.buttons["Home"].waitForExistence(timeout: 15))
    }

    private func openYou(_ app: XCUIApplication) {
        let avatars = app.buttons.matching(identifier: "avatar")
        XCTAssertTrue(avatars.firstMatch.waitForExistence(timeout: 10))
        (avatars.allElementsBoundByIndex.first { $0.isHittable } ?? avatars.firstMatch).tap()
        XCTAssertTrue(app.switches.firstMatch.waitForExistence(timeout: 10))
    }

    private func signOut(_ app: XCUIApplication) {
        let button = app.buttons["sign-out"]
        for _ in 0..<3 where !button.isHittable { app.swipeUp() }
        button.tap()
        // The confirmation's button has the same words.
        let confirm = app.buttons.matching(NSPredicate(format: "label == 'Sign out' AND identifier != 'sign-out'")).firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 5))
        confirm.tap()
    }

    /// Taps the knob itself: the middle of the row doesn't flip a switch.
    private func flipNotifications(_ app: XCUIApplication) {
        app.switches.firstMatch.coordinate(withNormalizedOffset: CGVector(dx: 0.93, dy: 0.5)).tap()
    }

    private func waitForSwitch(_ app: XCUIApplication, _ value: String, _ why: String) {
        let match = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: app.switches.firstMatch)
        XCTAssertEqual(XCTWaiter().wait(for: [match], timeout: 15), .completed, why)
    }

    private func launch(as name: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments += ["--reset-for-ui-tests", "--demo-sign-in=\(name)"]
        app.launch()
        allowNotificationsIfAsked()
        return app
    }

    func testKidSeesNoAdminThings() {
        let app = launch(as: "kiddo")
        XCTAssertTrue(app.tabBars.buttons["Discover"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.tabBars.buttons["Library"].exists)
        XCTAssertFalse(app.tabBars.buttons["Requests"].exists)
        XCTAssertFalse(app.tabBars.buttons["Downloads"].exists)
        app.tabBars.buttons["Discover"].tap()
        XCTAssertTrue(app.navigationBars["Discover"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["search"].exists)
    }

    func testMemberHasRequestsOnly() {
        let app = launch(as: "mia")
        XCTAssertTrue(app.tabBars.buttons["Requests"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.tabBars.buttons["Downloads"].exists)
        XCTAssertFalse(app.staticTexts["Watching now"].exists)
    }

    func testAdminReachesWatchingAndPeople() {
        let app = launch(as: "josh")
        // Home → Watching now → a stream, which opens its title.
        XCTAssertTrue(app.staticTexts["Watching now"].waitForExistence(timeout: 20), "Home shows who is watching")
        app.buttons.matching(NSPredicate(format: "label CONTAINS 'Watching' AND label BEGINSWITH '2'")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Now watching"].waitForExistence(timeout: 10))
        let session = app.buttons["session-s1"]
        XCTAssertTrue(session.waitForExistence(timeout: 10))
        session.tap()
        XCTAssertTrue(app.buttons["something-wrong"].waitForExistence(timeout: 10), "A stream opens its title")
        app.navigationBars.buttons.firstMatch.tap()
        app.navigationBars.buttons.firstMatch.tap()
        let avatars = app.buttons.matching(identifier: "avatar")
        (avatars.allElementsBoundByIndex.first { $0.isHittable } ?? avatars.firstMatch).tap()
        let manage = app.buttons["manage"]
        XCTAssertTrue(manage.waitForExistence(timeout: 10))
        manage.tap()
        XCTAssertTrue(app.staticTexts["People"].waitForExistence(timeout: 10))
        app.staticTexts["People"].tap()
        XCTAssertTrue(app.buttons["person-mia"].waitForExistence(timeout: 10))
    }
}
