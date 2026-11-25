import MarqueeKit
import SwiftUI

/// "Something wrong?": tell the admins what's off with a movie or show.
struct IssueSheet: View {
    let model: TitleModel
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var problem = "picture"
    @State private var message = ""
    @State private var sending = false

    private let kinds: [(String, String)] = [("picture", "The picture"), ("sound", "The sound"), ("subtitles", "The subtitles"), ("wrong_title", "It's the wrong title"), ("other", "Something else")]

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Picker("What's wrong?", selection: $problem) {
                    ForEach(kinds, id: \.0) { Text($0.1).tag($0.0) }
                }
                .pickerStyle(.menu)
                TextField("Tell us more (optional)", text: $message, axis: .vertical)
                    .lineLimit(3...6)
                    .fieldStyle()
                Button {
                    Task {
                        sending = true
                        if await model.report(app, problem: problem, message: message) { dismiss() }
                        sending = false
                    }
                } label: {
                    if sending { ProgressView().tint(.amberInk) } else { Text("Tell the admins") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(sending)
                .accessibilityIdentifier("send-issue")
                Spacer()
            }
            .padding(20)
            .background(.ink)
            .navigationTitle("Something wrong?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .presentationDetents([.medium])
        .presentationBackground(Color(hex: 0x0E1117))
    }
}
