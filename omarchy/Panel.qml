// The panel: the list you open when the bar item says something changed.
//
// A list, not a dashboard. The point is to read it in two seconds and then
// either go to a terminal or forget about it. It shows the same fields, in the
// same order, with the same words as `moshcode ps` and `moshcode cost`, so
// nobody has to learn a second vocabulary for the same fleet.
//
// Read-only, on purpose (PRD 0017 R8). Attaching and stopping are writes from
// an unsandboxed process; the version that only looks has to be boring in the
// wild first.
import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Ui
import qs.Commons

import "Model.js" as Model

KeyboardPanel {
    id: panel

    // Set by the bar widget when it loads this. Everything rendered here comes
    // from its snapshot; the panel never polls on its own.
    property var widget: null
    readonly property var snapshot: widget ? widget.snapshot : null
    readonly property var counts: snapshot ? Model.counts(snapshot) : ({ live: 0, working: 0, blocked: 0, idle: 0, done: 0 })

    readonly property color fg: widget && widget.fg !== undefined ? widget.fg : "white"
    readonly property color accent: widget && widget.accent !== undefined ? widget.accent : fg

    function open() { panel.visible = true; if (widget) widget.opened = true; }
    function close() { panel.visible = false; if (widget) widget.opened = false; }

    PanelKeyCatcher {
        anchors.fill: parent
        onEscape: panel.close()
    }

    ColumnLayout {
        id: body
        anchors.margins: 14
        anchors.fill: parent
        spacing: 10

        Text {
            text: {
                if (!snapshot) return "moshcode is not answering";
                if (snapshot.unavailable) return snapshot.reason || "unavailable";
                return counts.live + " live · " + counts.working + " working · " + counts.blocked + " blocked · " + counts.idle + " idle";
            }
            color: counts.blocked > 0 ? panel.accent : panel.fg
            font.bold: true
        }

        // Blocked first and always: an agent that asked a question twenty
        // minutes ago is the only row here anyone has to act on.
        Repeater {
            model: snapshot && snapshot.alerts ? snapshot.alerts : []
            delegate: Text {
                required property var modelData
                text: "⚠ " + modelData.subject + " is " + modelData.kind + " — " + Model.age(modelData.ageMs)
                color: panel.accent
            }
        }

        Rectangle { Layout.fillWidth: true; height: 1; color: panel.fg; opacity: 0.15 }

        Repeater {
            model: snapshot && snapshot.agents ? snapshot.agents : []
            delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                spacing: 10

                Text {
                    text: modelData.name
                    color: panel.fg
                    font.bold: modelData.state === "blocked"
                    Layout.preferredWidth: 110
                    elide: Text.ElideRight
                }
                Text {
                    text: modelData.blockedOn ? modelData.state + ":" + modelData.blockedOn : modelData.state
                    color: modelData.state === "blocked" ? panel.accent : panel.fg
                    opacity: modelData.alive ? 1.0 : 0.5
                    Layout.preferredWidth: 110
                }
                Text {
                    text: modelData.engine + (modelData.approvals === "bypass" ? "  ⚡" : "")
                    color: panel.fg
                    opacity: 0.8
                    Layout.preferredWidth: 90
                }
                Text {
                    text: modelData.swarm ? modelData.swarm : (modelData.fleet ? modelData.fleet : "")
                    color: panel.fg
                    opacity: 0.6
                    Layout.preferredWidth: 130
                    elide: Text.ElideMiddle
                }
                Text {
                    text: Model.age(modelData.ageMs)
                    color: panel.fg
                    opacity: 0.6
                    Layout.preferredWidth: 60
                }
                Text {
                    text: Model.tail(modelData.cwd, 2)
                    color: panel.fg
                    opacity: 0.6
                    Layout.fillWidth: true
                    elide: Text.ElideMiddle
                }
            }
        }

        Text {
            visible: snapshot && snapshot.agents && snapshot.agents.length === 0
            text: "nothing running — moshcode start claude"
            color: panel.fg
            opacity: 0.6
        }

        Rectangle { Layout.fillWidth: true; height: 1; color: panel.fg; opacity: 0.15 }

        Repeater {
            model: snapshot && snapshot.burn ? snapshot.burn : []
            delegate: RowLayout {
                required property var modelData
                Layout.fillWidth: true
                spacing: 10
                Text { text: modelData.label; color: panel.fg; opacity: 0.8; Layout.preferredWidth: 110 }
                Text { text: Model.money(modelData.cost); color: panel.fg; Layout.preferredWidth: 90 }
                Text {
                    text: modelData.perHour !== null ? Model.money(modelData.perHour) + "/h" : ""
                    color: panel.fg
                    opacity: 0.8
                    Layout.preferredWidth: 90
                }
                Text {
                    text: modelData.runs + " run" + (modelData.runs === 1 ? "" : "s")
                    color: panel.fg
                    opacity: 0.6
                    Layout.fillWidth: true
                }
            }
        }

        // An engine that logs nothing priceable is not free, and a bar that
        // renders it as $0 is lying quietly.
        Text {
            visible: snapshot && snapshot.unpriced && snapshot.unpriced.length > 0
            text: snapshot && snapshot.unpriced ? "no rate for " + snapshot.unpriced.join(", ") + " — those tokens count toward nothing" : ""
            color: panel.fg
            opacity: 0.6
            wrapMode: Text.WordWrap
            Layout.fillWidth: true
        }

        Text {
            text: {
                if (!snapshot || !snapshot.generatedAt) return "";
                var bits = ["read " + Model.age(Date.now() - Date.parse(snapshot.generatedAt)) + " ago"];
                if (snapshot.burnCached) bits.push("cost cached");
                if (snapshot.burnSlow) bits.push("cost is slow here");
                if (snapshot.partial) bits.push("partial: " + snapshot.error);
                return bits.join(" · ");
            }
            color: panel.fg
            opacity: 0.45
        }
    }
}
