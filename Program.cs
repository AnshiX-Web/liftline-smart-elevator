using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Serialization;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

var storageDirectory = Path.Combine(app.Environment.ContentRootPath, "App_Data");
var storagePath = Path.Combine(storageDirectory, "alerts.json");
Directory.CreateDirectory(storageDirectory);

var alerts = new ConcurrentDictionary<string, EmergencyAlert>(StringComparer.OrdinalIgnoreCase);
if (File.Exists(storagePath))
{
    var savedAlerts = JsonSerializer.Deserialize<List<EmergencyAlert>>(
        File.ReadAllText(storagePath),
        new JsonSerializerOptions { PropertyNameCaseInsensitive = true }) ?? [];
    foreach (var alert in savedAlerts)
        alerts[alert.EmergencyId] = alert;
}

var storageLock = new object();
void SaveAlerts()
{
    lock (storageLock)
    {
        var temporaryPath = storagePath + ".tmp";
        var content = JsonSerializer.Serialize(
            alerts.Values.OrderByDescending(alert => alert.SubmittedAt),
            new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(temporaryPath, content);
        File.Move(temporaryPath, storagePath, overwrite: true);
    }
}

app.MapGet("/", () => Results.File(
    Path.Combine(app.Environment.ContentRootPath, "index.html"),
    "text/html"));

app.MapGet("/college-data.json", () => Results.File(
    Path.Combine(app.Environment.ContentRootPath, "college-data.json"),
    "application/json"));

app.MapGet("/api/health", () => Results.Ok(new { status = "healthy" }));

app.MapGet("/api/sos", () => Results.Ok(
    alerts.Values.OrderByDescending(alert => alert.SubmittedAt)));

app.MapPost("/api/sos/submit", (SosSubmission submission) =>
{
    var validationErrors = new List<string>();
    if (string.IsNullOrWhiteSpace(submission.PassengerId))
        validationErrors.Add("passenger_id is required.");
    if (string.IsNullOrWhiteSpace(submission.PassengerName))
        validationErrors.Add("passenger_name is required.");
    if (string.IsNullOrWhiteSpace(submission.ElevatorId))
        validationErrors.Add("elevator_id is required.");
    if (string.IsNullOrWhiteSpace(submission.Location))
        validationErrors.Add("location is required.");
    if (string.IsNullOrWhiteSpace(submission.Category))
        validationErrors.Add("category is required.");

    if (validationErrors.Count > 0)
        return Results.BadRequest(new { success = false, error = string.Join(" ", validationErrors) });

    var now = DateTimeOffset.Now;
    var emergencyId = $"EM-{now.Year}-{Guid.NewGuid():N}"[..15].ToUpperInvariant();
    var alert = new EmergencyAlert(
        emergencyId,
        submission.PassengerId!,
        submission.PassengerName!,
        submission.ElevatorId!,
        submission.Location!,
        submission.Category!,
        now,
        "Received");

    alerts[emergencyId] = alert;
    SaveAlerts();

    return Results.Ok(new
    {
        success = true,
        emergency_id = emergencyId,
        timestamp = now.ToString("hh:mm tt"),
        alert
    });
});

app.MapPost("/api/sos/{emergencyId}/status", (string emergencyId, StatusUpdate update) =>
{
    if (string.IsNullOrWhiteSpace(update.Status))
        return Results.BadRequest(new { success = false, error = "status is required." });

    var normalizedStatus = update.Status.Trim().ToLowerInvariant() switch
    {
        "acknowledged" => "Acknowledged",
        "rescue dispatched" => "Rescue dispatched",
        "resolved" => "Resolved",
        _ => null
    };
    if (normalizedStatus is null)
        return Results.BadRequest(new { success = false, error = "Status must be Acknowledged, Rescue dispatched, or Resolved." });

    if (!alerts.TryGetValue(emergencyId, out var existing))
        return Results.NotFound(new { success = false, error = "Emergency alert not found." });

    var updated = existing with { Status = normalizedStatus };
    alerts[emergencyId] = updated;
    SaveAlerts();
    return Results.Ok(new { success = true, alert = updated });
});

app.MapGet("/api/sos/{emergencyId}", (string emergencyId) =>
    alerts.TryGetValue(emergencyId, out var alert)
        ? Results.Ok(alert)
        : Results.NotFound(new { success = false, error = "Emergency alert not found." }));

app.Run();

record SosSubmission(
    [property: JsonPropertyName("passenger_id")] string? PassengerId,
    [property: JsonPropertyName("passenger_name")] string? PassengerName,
    [property: JsonPropertyName("elevator_id")] string? ElevatorId,
    [property: JsonPropertyName("location")] string? Location,
    [property: JsonPropertyName("category")] string? Category);

record StatusUpdate(string? Status);

record EmergencyAlert(
    string EmergencyId,
    string PassengerId,
    string PassengerName,
    string ElevatorId,
    string Location,
    string Category,
    DateTimeOffset SubmittedAt,
    string Status);
