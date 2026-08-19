import requests
import json

def fetch_and_process_data(api_url):
    """Fetches data from an API and processes it."""
    print(f"Attempting to fetch data from: {api_url}")
    try:
        # 1. Fetch data using requests
        response = requests.get(api_url)
        response.raise_for_status()  # Raise HTTPError for bad responses (4xx or 5xx)
        data = response.json()

        print("Successfully fetched data.")

        # 2. Process the data (Example: Assuming 'posts' structure from JSONPlaceholder)
        if isinstance(data, list):
            processed_items = []
            for item in data:
                # Example processing: Extract title and user ID
                title = item.get("title", "No Title")
                user_id = item.get("userId", "Unknown User")
                processed_items.append(f"User {user_id}: '{title[:30]}...'")

            print("\n--- Processed Data Summary ---")
            for p in processed_items:
                print(p)
            print("-----------------------------")
        elif isinstance(data, dict):
             # Handle case where the root object is a dictionary (e.g., {"message": "success"})
            if 'posts' in data and isinstance(data['posts'], list):
                 processed_items = []
                 for item in data['posts']:
                    title = item.get("title", "No Title")
                    user_id = item.get("userId", "Unknown User")
                    processed_items.append(f"User {user_id}: '{title[:30]}...'")

                 print("\n--- Processed Data Summary ---")
                 for p in processed_items:
                     print(p)
                 print("-----------------------------")
            else:
                print("Data structure unexpected. Printing raw keys:")
                print(list(data.keys()))


    except requests.exceptions.RequestException as e:
        print(f"An error occurred during the API request: {e}")
    except json.JSONDecodeError:
        print("Error decoding JSON response. Received non-JSON data.")

if __name__ == "__main__":
    # Using a public placeholder API endpoint for demonstration
    API_URL = "https://jsonplaceholder.typicode.com/posts"
    fetch_and_process_data(API_URL)
