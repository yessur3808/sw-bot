import requests
import json

def fetch_and_process(url):
    """Fetches data from a URL and processes it."""
    try:
        # 1. Fetch data using requests
        response = requests.get(url)
        response.raise_for_status() # Raise an exception for bad status codes (4xx or 5xx)
        data = response.json()

        print("--- Data successfully fetched and parsed ---")
        # Assuming the structure is a list of items, we'll process it generically.
        if isinstance(data, list):
            processed_list = []
            for item in data:
                # Example processing: extracting 'title' and 'description' if they exist
                title = item.get('title', 'No Title')
                description = item.get('description', 'No Description')
                processed_list.append({
                    "Title": title,
                    "Description Snippet": description[:50] + "..." if len(description) > 50 else description
                })
            print("Processed Data (List of Items):")
            for item in processed_list:
                print(f"  - Title: {item['Title']}, Description: {item['Description Snippet']}")
        elif isinstance(data, dict):
            # If it's a single object, print its keys and values
            print("Processed Data (Single Object):")
            for key, value in data.items():
                print(f"  - Key: {key}, Value Type: {type(value).__name__}")
        else:
            print("Data format is neither a list nor a dictionary.")

    except requests.exceptions.RequestException as e:
        print(f"Error fetching data from {url}: {e}")
    except json.JSONDecodeError:
        print("Error decoding JSON: The response content was not valid JSON.")
    except Exception as e:
        print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    # Using a placeholder URL for demonstration purposes (e.g., JSONPlaceholder)
    TARGET_URL = "https://jsonplaceholder.typicode.com/posts?_limit=3"
    fetch_and_process(TARGET_URL)
