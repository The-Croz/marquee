import MarqueeKit
import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.openURL) private var openURL
    @State private var model: HomeModel?

    var body: some View {
        @Bindable var app = app
        NavigationStack(path: $app.homePath) {
            Group {
                if let model { content(model) } else { Color.ink }
            }
            .background(.ink)
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: TitleRoute.self) { TitleView(route: $0) }
        }
        .task { model = HomeModel(app: app) }
    }

    @ViewBuilder
    private func content(_ model: HomeModel) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 20) {
                    hero(model)
                    if let data = model.data {
                        sections(data, model: model, proxy: proxy)
                    } else if model.loading {
                        loadingSkeleton
                    } else if let problem = model.loadProblem {
                        MessageView(title: problem.title, detail: problem.advice, actionTitle: "Try again") { Task { await model.load() } }
                    }
                    if model.data != nil, let problem = model.loadProblem {
                        Text("Couldn't refresh · \(problem.title)").font(.caption).foregroundStyle(.dim).padding(.horizontal, 16)
                    }
                }
                .padding(.bottom, 24)
            }
            .ignoresSafeArea(edges: .top)
            .refreshable { await model.load() }
            .overlay(alignment: .top) { topBar(model, proxy: proxy) }
        }
        .refreshing(every: 5) { await model.load() }
        .alert("Couldn't do that", isPresented: Binding(get: { model.actionProblem != nil }, set: { if !$0 { model.actionProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.actionProblem ?? "")
        }
    }

    // MARK: Pieces

    private func topBar(_ model: HomeModel, proxy: ScrollViewProxy) -> some View {
        HStack {
            if let needs = model.data?.needsYou, !needs.isEmpty {
                GlassPill(text: "\(needs.count) need you", dot: .warn) {
                    withAnimation { proxy.scrollTo("needs", anchor: .top) }
                }
                .accessibilityIdentifier("need-you-pill")
            }
            Spacer()
            AvatarButton(initial: app.user?.displayName ?? "?") { app.showingYou = true }
                .accessibilityIdentifier("avatar")
        }
        .padding(.horizontal, 16)
        .padding(.top, 4)
    }

    @ViewBuilder
    private func hero(_ model: HomeModel) -> some View {
        if let hero = model.data?.hero {
            TitleLink(href: hero.href) {
            BackdropHero(
                path: hero.backdropPath,
                kicker: hero.eyebrow,
                title: hero.title,
                detail: ([hero.chips.joined(separator: " · ")] + [hero.note].compactMap { $0 }).filter { !$0.isEmpty }.joined(separator: " · "),
                progress: hero.progress.map { $0 / 100 }
            )
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                Text("Marquee").font(.titleSerif(40)).foregroundStyle(.amber)
                Text(greeting).font(.subheadline).foregroundStyle(.muted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
            .padding(.top, 96)
        }
    }

    private var greeting: String {
        let name = app.user?.displayName ?? ""
        return name.isEmpty ? "Welcome" : "Hello, \(name)"
    }

    @ViewBuilder
    private func sections(_ data: HomeData, model: HomeModel, proxy: ScrollViewProxy) -> some View {
        let admin = app.user?.role == .admin
        if admin {
            HStack(spacing: 8) {
                tile(data.onItsWay.count, "On the way", .downloadBlue, section: .downloads)
                CountTile(count: data.watching.count, label: "Watching", tint: .readyTeal)
                tile(data.needsYou.count, "Need you", .warn, section: .requests)
            }
            .padding(.horizontal, 16)
        }

        if !data.needsYou.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "Needs you")
                    .padding(.trailing, 16)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(data.needsYou) { item in needsYouCard(item, model: model) }
                    }
                    .padding(.trailing, 16)
                }
            }
            .padding(.leading, 16)
            .id("needs")
        }

        if !data.onItsWay.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "On its way")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 12) {
                        ForEach(data.onItsWay) { d in
                            ProgressCard(backdrop: nil, poster: d.posterPath, title: d.title, progress: d.percent / 100, detail: d.label)
                        }
                    }
                    .padding(.trailing, 16)
                }
            }
            .padding(.leading, 16)
        }

        if !data.myRequests.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "Your requests")
                PanelCard {
                    ForEach(data.myRequests) { r in
                        RequestRow(request: r).padding(.horizontal, 12)
                        if r.id != data.myRequests.last?.id { Divider().overlay(Color.line) }
                    }
                }
            }
            .padding(.horizontal, 16)
        }

        if admin && !data.recentRequests.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "Recent requests", trailing: ("See all", { openActivity(.requests) }))
                PanelCard {
                    let shown = Array(data.recentRequests.prefix(4))
                    ForEach(shown) { r in
                        RequestRow(request: r).padding(.horizontal, 12)
                        if r.id != shown.last?.id { Divider().overlay(Color.line) }
                    }
                }
            }
            .padding(.horizontal, 16)
        }

        if !data.recent.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "Just arrived")
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(data.recent) { t in
                            TitleLink(href: t.href) {
                            VStack(alignment: .leading, spacing: 4) {
                                PosterView(path: t.posterPath, color: t.posterColor, title: t.title).frame(width: 110)
                                Text(t.title).font(.footnote.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1).frame(width: 110, alignment: .leading)
                                Text(t.sub).font(.caption2).foregroundStyle(.muted).lineLimit(1).frame(width: 110, alignment: .leading)
                            }
                            .accessibilityElement(children: .combine)
                            }
                        }
                    }
                    .padding(.trailing, 16)
                }
            }
            .padding(.leading, 16)
            .accessibilityIdentifier("just-arrived")
        }

        if !data.upcoming.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                SectionTitle(text: "This week")
                PanelCard {
                    ForEach(data.upcoming) { u in
                        HStack(spacing: 12) {
                            Text(u.day).font(.caption.weight(.semibold)).foregroundStyle(.amberHi).frame(width: 52, alignment: .leading)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(u.title).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary)
                                Text(u.note).font(.caption).foregroundStyle(.muted)
                            }
                            Spacer()
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(minHeight: 52)
                        .accessibilityElement(children: .combine)
                        if u.id != data.upcoming.last?.id { Divider().overlay(Color.line) }
                    }
                }
            }
            .padding(.horizontal, 16)
        }

        if data.needsYou.isEmpty && data.onItsWay.isEmpty && data.recent.isEmpty && data.myRequests.isEmpty && data.upcoming.isEmpty && data.recentRequests.isEmpty {
            MessageView(title: "All quiet", detail: admin ? "Nothing needs you and nothing is downloading. Ask for something from Discover on the web, and it shows up here." : "Nothing here yet. When something you asked for arrives, it shows up here.")
        }
    }

    private func tile(_ count: Int, _ label: String, _ tint: Color, section: ActivitySection) -> some View {
        Button { openActivity(section) } label: { CountTile(count: count, label: label, tint: tint) }
            .buttonStyle(.plain)
            .accessibilityHint("Opens \(section.title)")
    }

    private func openActivity(_ section: ActivitySection) {
        app.activitySection = section
        app.selectedTab = .activity
    }

    // MARK: Needs you

    @ViewBuilder
    private func needsYouCard(_ item: HomeData.Attention, model: HomeModel) -> some View {
        if let id = item.approveId {
            HStack(spacing: 10) {
                PosterView(path: item.posterPath, color: nil, title: "", size: .w185).frame(width: 42).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2)
                    if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.muted).lineLimit(1) }
                }
                Spacer(minLength: 0)
                Button { Task { await model.approve(id) } } label: {
                    Image(systemName: "checkmark").font(.system(size: 16, weight: .bold)).foregroundStyle(.amberInk)
                        .frame(width: 44, height: 44).background(Color.amber, in: Circle())
                        .opacity(model.approving.contains(id) ? 0.5 : 1)
                }
                .disabled(model.approving.contains(id))
                .accessibilityLabel("Approve \(item.title)")
                .accessibilityIdentifier("approve-\(id)")
            }
            .padding(.horizontal, 10)
            .frame(width: 290, height: 80)
            .background(Color.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color.line, lineWidth: 1))
        } else {
            Button { open(item) } label: {
                HStack(spacing: 10) {
                    Image(systemName: "exclamationmark.circle").font(.system(size: 20)).foregroundStyle(.warn)
                        .frame(width: 42, height: 42).background(Color.warn.opacity(0.15), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(2).multilineTextAlignment(.leading)
                        if let detail = item.detail { Text(detail).font(.caption).foregroundStyle(.muted).lineLimit(2).multilineTextAlignment(.leading) }
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(width: 290, height: 80)
                .background(Color.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(Color(hex: 0x3A2A22), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityHint(item.action)
        }
    }

    /// A problem card goes where the web would: Activity for downloads and requests, else the web page.
    private func open(_ item: HomeData.Attention) {
        if item.to.hasPrefix("/downloads") { openActivity(.downloads) } else if item.to.hasPrefix("/requests") { openActivity(.requests) } else {
            Task {
                let base = await app.client.activeAddress
                if let url = URL(string: base.absoluteString + item.to) { openURL(url) }
            }
        }
    }

    private var loadingSkeleton: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(spacing: 8) { ForEach(0..<3, id: \.self) { _ in Skeleton(height: 64, radius: 16) } }
            Skeleton(height: 80, radius: 18)
            HStack { ForEach(0..<3, id: \.self) { _ in Skeleton(width: 110, height: 165, radius: 10) } }
        }
        .padding(.horizontal, 16)
        .accessibilityLabel("Loading")
    }
}

/// A request in a list: poster, title, who asked and when, and its plain state.
struct RequestRow: View {
    let request: RequestView
    var showsPerson = true

    var body: some View {
        HStack(spacing: 12) {
            PosterView(path: request.posterPath, color: nil, title: request.title, size: .w185).frame(width: 40)
            VStack(alignment: .leading, spacing: 3) {
                Text(Format.requestTitle(request)).font(.subheadline.weight(.semibold)).foregroundStyle(.textPrimary).lineLimit(1)
                Text(subtitle).font(.caption).foregroundStyle(.muted).lineLimit(1)
                StateLine(text: request.stateText, tone: tone)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        var parts: [String] = []
        if showsPerson, let who = request.requestedBy?.name { parts.append(who) }
        parts.append(Format.ago(request.createdAt))
        if let profile = request.profile { parts.append(profile) }
        return parts.joined(separator: " · ")
    }

    private var tone: Tone {
        switch request.state {
        case .ready: .ready
        case .downloading, .searching: .downloading
        case .looking, .pending: .needsYou
        default: .neutral
        }
    }
}

/// Opens a title when the server gave a page for it, else just shows the content.
struct TitleLink<Label: View>: View {
    let href: String?
    @ViewBuilder var label: Label

    var body: some View {
        if let route = TitleRoute(webPath: href) {
            NavigationLink(value: route) { label }.buttonStyle(.plain)
        } else {
            label
        }
    }
}
