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

        // Where is Marquee?
        let address = app.textFields["address-field"]
        XCTAssertTrue(address.waitForExistence(timeout: 10))
        address.tap()
        address.typeText("localhost:9797")
        app.buttons["connect"].tap()

        // Sign in.
        let username = app.textFields["username"]
        XCTAssertTrue(username.waitForExistence(timeout: 10), "Marquee should answer at localhost:9797 (is demo mode running?)")
        username.tap()
        username.typeText("josh")
        let password = app.secureTextFields["password"]
        password.tap()
        password.typeText("correct horse battery")
        app.buttons["sign-in"].tap()

        // Home loads.
        XCTAssertTrue(app.staticTexts["Needs you"].waitForExistence(timeout: 15), "Home should show Needs you")
        XCTAssertTrue(app.buttons["avatar"].exists)

        // Activity → Requests → approve the first one.
        app.tabBars.buttons["Activity"].tap()
        app.buttons["Requests"].tap()
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

        // You → turn notifications on (allow the system prompt); the script then checks the fake Apple saw a push.
        // The Discover sheet is still up from asking: close it, then open You from the tab's avatar.
        if app.buttons["Done"].exists { app.buttons["Done"].tap() }
        let avatars = app.buttons.matching(identifier: "avatar")
        XCTAssertTrue(avatars.firstMatch.waitForExistence(timeout: 10))
        (avatars.allElementsBoundByIndex.first { $0.isHittable } ?? avatars.firstMatch).tap()
        let toggle = app.switches.firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        toggle.tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.alerts.buttons["Allow"]
        if allow.waitForExistence(timeout: 10) { allow.tap() }
        let on = NSPredicate(format: "value == '1'")
        wait(for: [XCTNSPredicateExpectation(predicate: on, object: toggle)], timeout: 15)
    }
}
