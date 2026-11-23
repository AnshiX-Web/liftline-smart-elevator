$port = 4173
if ($args.Count -gt 0) {
    $port = [int]$args[0]
}
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$prefix = "http://127.0.0.1:$port/"
$storageDirectory = Join-Path $root "App_Data"
$storagePath = Join-Path $storageDirectory "alerts.json"
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add($prefix)
$listener.Start()

if (-not (Test-Path -LiteralPath $storageDirectory)) {
    New-Item -ItemType Directory -Path $storageDirectory | Out-Null
}

$alerts = @{}
if (Test-Path -LiteralPath $storagePath) {
    $savedAlerts = Get-Content -LiteralPath $storagePath -Raw | ConvertFrom-Json
    foreach ($alert in @($savedAlerts)) {
        if ($alert.emergencyId) {
            $alerts[[string]$alert.emergencyId] = $alert
        }
    }
}

function Write-JsonResponse {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [object]$Payload
    )

    $json = ConvertTo-Json -InputObject $Payload -Depth 8 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = "application/json; charset=utf-8"
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.Close()
}

function Save-Alerts {
    $ordered = @($alerts.Values | Sort-Object -Property submittedAt -Descending)
    $json = ConvertTo-Json -InputObject $ordered -Depth 8
    $temporaryPath = "$storagePath.tmp"
    [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.Encoding]::UTF8)
    Move-Item -LiteralPath $temporaryPath -Destination $storagePath -Force
}

Write-Host "Smart Elevator preview: $prefix"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response
        $path = $request.Url.AbsolutePath

        if ($request.HttpMethod -eq "GET" -and $path -eq "/api/health") {
            Write-JsonResponse -Response $response -StatusCode 200 -Payload @{ status = "healthy" }
            continue
        }

        if ($request.HttpMethod -eq "GET" -and $path -eq "/api/sos") {
            $items = @($alerts.Values | Sort-Object -Property submittedAt -Descending)
            Write-JsonResponse -Response $response -StatusCode 200 -Payload $items
            continue
        }

        if ($request.HttpMethod -eq "POST" -and $path -eq "/api/sos/submit") {
            $reader = [System.IO.StreamReader]::new($request.InputStream, $request.ContentEncoding)
            $body = $reader.ReadToEnd()
            $reader.Dispose()
            try {
                $submission = $body | ConvertFrom-Json
            } catch {
                Write-JsonResponse -Response $response -StatusCode 400 -Payload @{ success = $false; error = "Invalid JSON request." }
                continue
            }

            $required = @("passenger_id", "passenger_name", "elevator_id", "location", "category")
            $missing = @(
                foreach ($name in $required) {
                    if ([string]::IsNullOrWhiteSpace([string]$submission.$name)) { $name }
                }
            )
            if ($missing.Count -gt 0) {
                Write-JsonResponse -Response $response -StatusCode 400 -Payload @{
                    success = $false
                    error = "Missing required fields: " + ($missing -join ", ")
                }
                continue
            }

            $now = Get-Date
            $emergencyId = "EM-$($now.Year)-$([guid]::NewGuid().ToString('N').Substring(0, 7).ToUpperInvariant())"
            $alert = [ordered]@{
                emergencyId = $emergencyId
                passengerId = [string]$submission.passenger_id
                passengerName = [string]$submission.passenger_name
                elevatorId = [string]$submission.elevator_id
                location = [string]$submission.location
                category = [string]$submission.category
                submittedAt = $now.ToString("o")
                status = "Received"
            }
            $alerts[$emergencyId] = $alert
            Save-Alerts
            Write-JsonResponse -Response $response -StatusCode 200 -Payload @{
                success = $true
                emergency_id = $emergencyId
                timestamp = $now.ToString("hh:mm tt")
                alert = $alert
            }
            continue
        }

        if ($request.HttpMethod -eq "POST" -and $path -match "^/api/sos/([^/]+)/status$") {
            $emergencyId = [Uri]::UnescapeDataString($Matches[1])
            $reader = [System.IO.StreamReader]::new($request.InputStream, $request.ContentEncoding)
            $body = $reader.ReadToEnd()
            $reader.Dispose()
            try {
                $update = $body | ConvertFrom-Json
            } catch {
                Write-JsonResponse -Response $response -StatusCode 400 -Payload @{ success = $false; error = "Invalid JSON request." }
                continue
            }

            $statusMap = @{
                "acknowledged" = "Acknowledged"
                "rescue dispatched" = "Rescue dispatched"
                "resolved" = "Resolved"
            }
            $requestedStatus = [string]$update.status
            $normalizedStatus = $statusMap[$requestedStatus.Trim().ToLowerInvariant()]
            if (-not $normalizedStatus) {
                Write-JsonResponse -Response $response -StatusCode 400 -Payload @{
                    success = $false
                    error = "Status must be Acknowledged, Rescue dispatched, or Resolved."
                }
                continue
            }
            if (-not $alerts.ContainsKey($emergencyId)) {
                Write-JsonResponse -Response $response -StatusCode 404 -Payload @{
                    success = $false
                    error = "Emergency alert not found."
                }
                continue
            }

            $alert = $alerts[$emergencyId]
            $alert.status = $normalizedStatus
            $alerts[$emergencyId] = $alert
            Save-Alerts
            Write-JsonResponse -Response $response -StatusCode 200 -Payload @{ success = $true; alert = $alert }
            continue
        }

        if ($request.HttpMethod -eq "GET" -and $path -match "^/api/sos/([^/]+)$") {
            $emergencyId = [Uri]::UnescapeDataString($Matches[1])
            if ($alerts.ContainsKey($emergencyId)) {
                Write-JsonResponse -Response $response -StatusCode 200 -Payload $alerts[$emergencyId]
            } else {
                Write-JsonResponse -Response $response -StatusCode 404 -Payload @{
                    success = $false
                    error = "Emergency alert not found."
                }
            }
            continue
        }

        if ($request.HttpMethod -eq "GET" -and ($path -eq "/" -or $path -eq "/index.html")) {
            $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root "index.html"))
            $response.StatusCode = 200
            $response.ContentType = "text/html; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        if ($request.HttpMethod -eq "GET" -and $path -eq "/college-data.json") {
            $bytes = [System.IO.File]::ReadAllBytes((Join-Path $root "college-data.json"))
            $response.StatusCode = 200
            $response.ContentType = "application/json; charset=utf-8"
            $response.ContentLength64 = $bytes.Length
            $response.OutputStream.Write($bytes, 0, $bytes.Length)
            $response.Close()
            continue
        }

        $notFound = [System.Text.Encoding]::UTF8.GetBytes("Not found")
        $response.StatusCode = 404
        $response.ContentType = "text/plain; charset=utf-8"
        $response.ContentLength64 = $notFound.Length
        $response.OutputStream.Write($notFound, 0, $notFound.Length)
        $response.Close()
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
