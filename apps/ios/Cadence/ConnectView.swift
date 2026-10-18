import SwiftUI

/// First launch: ask for the Cadence server's address and check it serves /app.
struct ConnectView: View {
    @Binding var serverURL: String
    @State private var draft = ""
    @State private var error: String?
    @State private var checking = false

    var body: some View {
        VStack(spacing: 20) {
            Spacer()
            Image(systemName: "music.note.house.fill")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Cadence").font(.largeTitle.bold())
            Text("Enter the address of your Cadence server.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            TextField("music.example.com", text: $draft)
                .textFieldStyle(.roundedBorder)
                .keyboardType(.URL)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit(connect)
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Button(action: connect) {
                Group {
                    if checking { ProgressView() } else { Text("Connect") }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(draft.isEmpty || checking)
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: 480)
        .preferredColorScheme(.dark)
    }

    private func connect() {
        guard let url = ServerAddress.playerURL(from: draft) else {
            error = "That doesn't look like a server address."
            return
        }
        checking = true
        error = nil
        Task { @MainActor in
            defer { checking = false }
            do {
                let (_, response) = try await URLSession.shared.data(from: url)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    error = "Reached the server, but it has no web player at /app."
                    return
                }
                serverURL = draft
            } catch {
                self.error = "Couldn't reach the server: \(error.localizedDescription)"
            }
        }
    }
}
